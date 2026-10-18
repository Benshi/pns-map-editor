<?php
declare(strict_types=1);

function emptyAccess(): array
{
    return ['version' => 1, 'permissions' => [], 'requests' => [], 'notifications' => [],
        'read_through' => [], 'role_history' => []];
}

function readAccess(string $private): array
{
    $path = $private . DIRECTORY_SEPARATOR . 'access.json';
    if (!is_file($path)) {
        return emptyAccess();
    }
    $data = json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($data) || ($data['version'] ?? null) !== 1) {
        throw new RuntimeException('Invalid access registry.');
    }
    foreach (['permissions', 'requests', 'notifications', 'read_through', 'role_history'] as $key) {
        if (!is_array($data[$key] ?? null)) {
            throw new RuntimeException('Invalid access registry.');
        }
        foreach (['requests', 'notifications', 'role_history'] as $key) {
            if (!array_is_list($data[$key])) {
                throw new RuntimeException('Invalid access registry list.');
            }
        }
    }
    foreach ($data['permissions'] as $userId => $servers) {
        if (!is_string($userId) || !is_array($servers)) {
            throw new RuntimeException('Invalid access permissions.');
        }
        foreach ($servers as $server => $roles) {
            if (!preg_match('/^S[0-9]{1,10}$/D', (string) $server) || !is_array($roles)
                || !is_bool($roles['editor'] ?? null) || !is_bool($roles['approver'] ?? null)) {
                throw new RuntimeException('Invalid access roles.');
            }
        }
    }
    foreach ($data['requests'] as $request) {
        if (!is_array($request) || !is_string($request['id'] ?? null)
            || !is_string($request['user_id'] ?? null) || !is_string($request['server'] ?? null)
            || !preg_match('/^S[0-9]{1,10}$/D', $request['server'])
            || !is_string($request['message'] ?? null) || !is_string($request['created_at'] ?? null)
            || !in_array($request['status'] ?? null, ['pending', 'held', 'approved', 'rejected'], true)
            || !is_array($request['decisions'] ?? null)) {
            throw new RuntimeException('Invalid access request.');
        }
        foreach ($request['decisions'] as $decision) {
            if (!is_array($decision) || !is_string($decision['actor_id'] ?? null)
                || !in_array($decision['status'] ?? null, ['held', 'approved', 'rejected'], true)
                || !is_string($decision['message'] ?? null) || !is_string($decision['created_at'] ?? null)) {
                throw new RuntimeException('Invalid request decision.');
            }
        }
    }
    foreach ($data['notifications'] as $index => $notification) {
        if (!is_array($notification) || ($notification['id'] ?? null) !== $index + 1
            || !is_string($notification['user_id'] ?? null) || !is_string($notification['text'] ?? null)
            || !is_string($notification['created_at'] ?? null)) {
            throw new RuntimeException('Invalid access notification.');
        }
    }
    foreach ($data['read_through'] as $number) {
        if (!is_int($number) || $number < 0 || $number > count($data['notifications'])) {
            throw new RuntimeException('Invalid notification cursor.');
        }
    }
    return $data;
}

function canEditServer(?array $user, string $server, array $config, array $access): bool
{
    return $user !== null && canEdit($user)
        && (isAdmin($user, $config) || ($access['permissions'][$user['id']][$server]['editor'] ?? false));
}

function canApproveServer(?array $user, string $server, array $config, array $access): bool
{
    return $user !== null && !$user['suspended']
        && (isAdmin($user, $config) || ($access['permissions'][$user['id']][$server]['approver'] ?? false));
}

function accessMessage(mixed $value, bool $required = true): string
{
    if (!is_string($value) || strlen($value) > 4000 || preg_match('//u', $value) !== 1) {
        throw new InvalidArgumentException('メッセージは1000文字以内で入力してください。');
    }
    $value = trim(str_replace("\r\n", "\n", $value));
    if (($required && $value === '') || preg_match_all('/./us', $value) > 1000
        || preg_match('/\p{C}/u', str_replace(["\n", "\r", "\t"], '', $value))) {
        throw new InvalidArgumentException('メッセージは制御文字を含まない1〜1000文字にしてください。');
    }
    return $value;
}

function accessServer(mixed $value): string
{
    if (!is_string($value) || !preg_match('/^(?:S)?([0-9]{1,10})$/D', trim($value), $match)) {
        throw new InvalidArgumentException('サーバー番号を入力してください。');
    }
    return 'S' . $match[1];
}

function accessNotify(array &$access, string $userId, string $text): void
{
    $access['notifications'][] = ['id' => count($access['notifications']) + 1,
        'user_id' => $userId, 'text' => $text, 'created_at' => gmdate('Y-m-d\TH:i:s\Z')];
}

function unreadAccessCount(array $access, string $userId): int
{
    return count(array_filter($access['notifications'], static fn(array $item): bool =>
        $item['user_id'] === $userId && $item['id'] > ($access['read_through'][$userId] ?? 0)));
}

function updateAccess(string $private, callable $change): void
{
    // Share the users lock with suspension and map saves; authorization changes are atomic.
    $lock = fopen($private . DIRECTORY_SEPARATOR . 'users.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException('Could not open access lock.');
    }
    $temporary = null;
    try {
        if (!flock($lock, LOCK_EX)) {
            throw new RuntimeException('Could not lock access registry.');
        }
        $access = readAccess($private);
        $change($access, readUsers($private . DIRECTORY_SEPARATOR . 'users.json'));
        $json = json_encode($access, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
        $temporary = $private . DIRECTORY_SEPARATOR . 'access-' . bin2hex(random_bytes(16)) . '.tmp';
        if (file_put_contents($temporary, $json) !== strlen($json)
            || !rename($temporary, $private . DIRECTORY_SEPARATOR . 'access.json')) {
            throw new RuntimeException('Could not persist access registry.');
        }
        $temporary = null;
    } finally {
        try {
            if ($temporary !== null && file_exists($temporary) && !unlink($temporary)) {
                throw new RuntimeException('Could not remove temporary access file.');
            }
        } finally {
            fclose($lock);
        }
    }
}

function changeAccess(string $private, string $actorId, string $action, array $input, array $config): void
{
    updateAccess($private, static function (array &$access, array $users) use ($actorId, $action, $input, $config): void {
        $byId = array_column($users, null, 'id');
        $actor = $byId[$actorId] ?? null;
        if ($actor === null) {
            throw new InvalidArgumentException('ログインし直してください。');
        }
        if ($action === 'read') {
            $through = filter_var($input['through'] ?? null, FILTER_VALIDATE_INT);
            if ($through === false || $through < 0 || $through > count($access['notifications'])) {
                throw new InvalidArgumentException('通知を開き直してください。');
            }
            $access['read_through'][$actorId] = max($access['read_through'][$actorId] ?? 0, $through);
            return;
        }
        if ($action === 'request') {
            if (!canEdit($actor)) {
                throw new InvalidArgumentException('表示名の登録が必要です。編集停止中は申請できません。');
            }
            $server = accessServer($input['server'] ?? null);
            if (canEditServer($actor, $server, $config, $access)) {
                throw new InvalidArgumentException('このサーバーの編集権限は取得済みです。');
            }
            foreach ($access['requests'] as $request) {
                if ($request['user_id'] === $actorId && $request['server'] === $server
                    && in_array($request['status'], ['pending', 'held'], true)) {
                    throw new InvalidArgumentException('このサーバーには申請中または保留中の申請があります。');
                }
            }
            $access['requests'][] = ['id' => bin2hex(random_bytes(16)), 'user_id' => $actorId,
                'server' => $server, 'message' => accessMessage($input['message'] ?? null),
                'created_at' => gmdate('Y-m-d\TH:i:s\Z'), 'status' => 'pending', 'decisions' => []];
            foreach ($users as $user) {
                if (canApproveServer($user, $server, $config, $access)) {
                    accessNotify($access, $user['id'], $server . '：' . $actor['display_name'] . ' から編集権限の申請が届きました。');
                }
            }
            return;
        }
        if ($action === 'decision') {
            foreach ($access['requests'] as &$request) {
                if ($request['id'] !== ($input['request'] ?? null)) {
                    continue;
                }
                if (!canApproveServer($actor, $request['server'], $config, $access)
                    || $request['user_id'] === $actorId) {
                    throw new InvalidArgumentException('対象サーバーの承認権限が必要です。自分の申請は処理できません。');
                }
                if (!in_array($request['status'], ['pending', 'held'], true)) {
                    throw new InvalidArgumentException('この申請は処理済みです。画面を更新してください。');
                }
                $status = $input['status'] ?? null;
                if (!in_array($status, ['approved', 'rejected', 'held'], true)) {
                    throw new InvalidArgumentException('承認・却下・保留を選んでください。');
                }
                if (!isset($byId[$request['user_id']]) || $byId[$request['user_id']]['suspended']) {
                    throw new InvalidArgumentException('申請者は編集停止中、または存在しません。');
                }
                $message = accessMessage($input['message'] ?? '', $status !== 'approved');
                $request['status'] = $status;
                $request['decisions'][] = ['actor_id' => $actorId, 'status' => $status,
                    'message' => $message, 'created_at' => gmdate('Y-m-d\TH:i:s\Z')];
                if ($status === 'approved') {
                    $roles = $access['permissions'][$request['user_id']][$request['server']]
                        ?? ['editor' => false, 'approver' => false];
                    $roles['editor'] = true;
                    $access['permissions'][$request['user_id']][$request['server']] = $roles;
                }
                $label = ['approved' => '承認', 'rejected' => '却下', 'held' => '保留'][$status];
                accessNotify($access, $request['user_id'], $request['server'] . ' の編集申請が' . $label . 'されました。');
                return;
            }
            throw new InvalidArgumentException('申請が見つかりません。');
        }
        if ($action === 'roles') {
            foreach (['editor', 'approver'] as $role) {
                if (array_key_exists($role, $input) && $input[$role] !== '1') {
                    throw new InvalidArgumentException('権限の指定が不正です。画面から操作し直してください。');
                }
            }
            $server = accessServer($input['server'] ?? null);
            $target = $input['target'] ?? null;
            if (!is_string($target) || !isset($byId[$target]) || isAdmin($byId[$target], $config)
                || !canApproveServer($actor, $server, $config, $access)) {
                throw new InvalidArgumentException('対象利用者または管理権限を確認してください。');
            }
            $roles = $access['permissions'][$target][$server] ?? ['editor' => false, 'approver' => false];
            $roles['editor'] = ($input['editor'] ?? '') === '1';
            if (isAdmin($actor, $config)) {
                $roles['approver'] = ($input['approver'] ?? '') === '1';
            } elseif ($roles['approver'] || $target === $actorId || isset($input['approver'])) {
                throw new InvalidArgumentException('承認者の権限変更には最高管理者権限が必要です。');
            }
            $access['permissions'][$target][$server] = $roles;
            accessNotify($access, $target, $server . ' の権限が更新されました。編集：'
                . ($roles['editor'] ? '可' : '不可') . '／承認：' . ($roles['approver'] ? '可' : '不可'));
            $access['role_history'][] = ['actor_id' => $actorId, 'user_id' => $target, 'server' => $server,
                'roles' => $roles, 'created_at' => gmdate('Y-m-d\TH:i:s\Z')];
            return;
        }
        throw new InvalidArgumentException('対応していない操作です。');
    });
}
