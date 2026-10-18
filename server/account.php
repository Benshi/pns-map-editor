<?php
declare(strict_types=1);

function accountForm(array $config, string $route, array $hidden = []): string
{
    $html = '<form method="post" action="' . escape($config['base_url'] . $route) . '">'
        . '<input type="hidden" name="csrf" value="' . escape($_SESSION['csrf']) . '">';
    foreach ($hidden as $key => $value) {
        $html .= '<input type="hidden" name="' . escape($key) . '" value="' . escape((string) $value) . '">';
    }
    return $html;
}

function accountDate(?string $date): string
{
    return $date === null ? '不明' : escape((new DateTimeImmutable($date))
        ->setTimezone(new DateTimeZone('Asia/Tokyo'))->format('Y-m-d H:i')) . '（日本時間）';
}

function accountStatus(string $status): string
{
    return ['pending' => '申請中', 'held' => '保留', 'approved' => '承認済み', 'rejected' => '却下'][$status];
}

function accountQuery(string $name, string $default = ''): string
{
    $value = $_GET[$name] ?? $default;
    if (!is_string($value) || strlen($value) > 320) {
        throw new InvalidArgumentException('検索条件が不正です。');
    }
    return trim($value);
}

function accountPagination(array $items): array
{
    $pages = max(1, (int) ceil(count($items) / 20));
    $raw = accountQuery('page', '1');
    $page = ctype_digit($raw) ? max(1, min($pages, (int) $raw)) : 1;
    $html = '<nav aria-label="ページ切り替え"><span>' . count($items) . '件 / ' . $page . ' / ' . $pages . 'ページ</span>';
    foreach ([$page - 1 => '前へ', $page + 1 => '次へ'] as $number => $label) {
        if ($number >= 1 && $number <= $pages) {
            $query = [];
            foreach ($_GET as $key => $value) {
                if (is_string($value) && $key !== 'return') {
                    $query[$key] = $value;
                }
            }
            $html .= '<a href="?' . escape(http_build_query(array_replace($query, ['page' => $number]))) . '">' . $label . '</a>';
        }
    }
    return [array_slice($items, ($page - 1) * 20, 20), $html . '</nav>'];
}

function accountRequestCard(array $request, array $users): string
{
    $html = '<article><details name="request-detail"><summary>' . escape($request['server']) . ' <span class="badge">'
        . accountStatus($request['status']) . '</span> · '
        . escape($users[$request['user_id']]['display_name'] ?? '表示名未登録') . '</summary><p>'
        . escape($users[$request['user_id']]['display_name'] ?? '表示名未登録') . ' · '
        . escape($request['user_id']) . '<br>申請日時：' . accountDate($request['created_at'])
        . '</p><p class="message">' . escape($request['message']) . '</p>';
    foreach ($request['decisions'] as $decision) {
        $html .= '<p class="message">管理者から：' . accountStatus($decision['status']) . ' / '
            . accountDate($decision['created_at']) . '<br>' . escape($decision['message'])
            . '<br><small>処理者：' . escape($decision['actor_id']) . '</small></p>';
    }
    return $html;
}

function renderAccount(string $private, array $config, ?array $user, array $users, array $access, string $mapReturn): never
{
    try {
        $view = accountQuery('view');
        $queryServer = accountQuery('server');
        $mapQuery = [];
        parse_str($_SESSION['map_return_query'] ?? '', $mapQuery);
        $contextServer = '';
        if (is_string($mapQuery['map'] ?? null)) {
            $contextServer = sharedCodeServer($private, registeredMapServers($private, $config['servers']), $mapQuery['map']) ?? '';
        } elseif (is_string($mapQuery['server'] ?? null) && preg_match('/^(?:S)?[0-9]{1,10}$/D', $mapQuery['server'])) {
            $contextServer = accessServer($mapQuery['server']);
        }
        $server = $queryServer !== '' ? accessServer($queryServer) : ($view === 'admin' ? '' : $contextServer);
        $super = $user !== null && !$user['suspended'] && isAdmin($user, $config);
        $approver = $user !== null && !$user['suspended']
            && count(array_filter($access['permissions'][$user['id']] ?? [], static fn(array $roles): bool => $roles['approver'])) > 0;
        $manage = $super || $approver;
        if ($view === 'admin' && !$manage) {
            page('管理者権限が必要です', '<p><a href="' . escape($config['base_url']) . '">利用者設定に戻る</a></p>', 403);
        }
        $tab = accountQuery('tab', $user !== null && $user['display_name'] === null ? 'profile' : 'access');
        if ($view !== 'admin' && !in_array($tab, ['access', 'notifications', 'requests', 'profile'], true)) {
            throw new InvalidArgumentException('表示するメニューを選び直してください。');
        }
        $html = '<div class="account-shell"><nav class="account-nav" aria-label="画面操作"><a class="primary" href="' . escape($mapReturn) . '">マップに戻る</a>';
        if ($user !== null && $view === 'admin') {
            $html .= '<a href="' . escape($config['base_url']) . '">アカウント</a>';
        }
        if ($manage) {
            $pending = count(array_filter($access['requests'], static fn(array $request): bool =>
                in_array($request['status'], ['pending', 'held'], true)
                && canApproveServer($user, $request['server'], $config, $access)));
            $html .= '<a href="?view=admin"' . ($view === 'admin' ? ' aria-current="page"' : '')
                . '>管理 <span class="badge">' . $pending . '</span></a>';
        }
        if ($user !== null) {
            $html .= accountForm($config, '/auth/logout') . '<button>ログアウト</button></form>';
            $html .= '</nav><p class="account-identity"><strong>' . escape($user['display_name'] ?? '表示名未登録')
                . '</strong> · ' . ($super ? '最高管理者' : ($approver ? 'サーバー承認者' : '一般利用者'))
                . ($user['suspended'] ? ' · 編集停止中' : '') . '</p>';
            if ($view !== 'admin') {
                $html .= '<nav class="account-tabs" aria-label="アカウントメニュー">';
                foreach (['access' => '編集権限', 'requests' => '申請状況',
                    'notifications' => '通知 ' . unreadAccessCount($access, $user['id']), 'profile' => '表示名'] as $key => $label) {
                    $html .= '<a href="?tab=' . $key . '"' . ($tab === $key ? ' aria-current="page"' : '')
                        . '>' . $label . '</a>';
                }
                $html .= '</nav>';
            }
        } else {
            $html .= '</nav>';
        }
        $html .= '<main class="account-content" tabindex="0" aria-label="設定内容">';
        if (isset($_SESSION['account_notice'])) {
            $html .= '<p role="status" class="notice">' . escape($_SESSION['account_notice']) . '</p>';
            unset($_SESSION['account_notice']);
        }
        if ($user === null) {
            $html .= '<section><h2>ログイン</h2><p>マップの閲覧はログイン不要です。編集にはGoogleログイン・表示名登録と、サーバーごとの承認が必要です。</p>'
                . accountForm($config, '/auth/login') . '<button>Google でログイン</button></form>'
                . '<details><summary>ログインで利用する情報</summary><p>Googleのメールアドレスは要求・保存しません。ログインしただけでは編集権限は付与されません。</p></details></section>';
            page('ログイン', $html . '</main></div>');
        }
        $byId = array_column($users, null, 'id');
        if ($view === 'admin') {
            $html .= renderAdmin($config, $user, $users, $access, $server, $super);
            page('管理者画面', $html . '</main></div>');
        }
        if ($tab === 'access') {
            $html .= '<section><h2>編集権限</h2>';
            $permissions = $access['permissions'][$user['id']] ?? [];
            if ($super) {
                $html .= '<p>全サーバーの編集・承認・承認者任命が可能です。申請は不要です。</p>';
            } elseif ($permissions === []) {
                $html .= '<p>編集するサーバーの権限を申請してください。</p>';
            }
            if ($server !== '' && !$super) {
                $roles = $permissions[$server] ?? ['editor' => false, 'approver' => false];
                $html .= '<p><strong>' . escape($server) . '</strong>：編集者 '
                    . ($roles['editor'] ? 'あり' : 'なし') . ' / 承認者 ' . ($roles['approver'] ? 'あり' : 'なし') . '</p>';
            }
            if ($permissions !== []) {
                $html .= '<details><summary>全サーバーのロール（' . count($permissions) . '件）</summary>';
                foreach ($permissions as $id => $roles) {
                    $html .= '<p><strong>' . escape($id) . '</strong>：編集者 '
                        . ($roles['editor'] ? 'あり' : 'なし') . ' / 承認者 ' . ($roles['approver'] ? 'あり' : 'なし') . '</p>';
                }
                $html .= '</details>';
            }
            if (canEdit($user) && !$super) {
                $html .= accountForm($config, '/account/request')
                    . '<label>サーバー番号<input name="server" inputmode="numeric" pattern="(?:S)?[0-9]{1,10}" required value="'
                    . escape($server) . '" placeholder="サーバー番号"></label>'
                    . '<label>申請メッセージ<textarea name="message" maxlength="1000" required rows="2" placeholder="所属ギルドや編集したい内容など"></textarea></label>'
                    . '<button>編集権限を申請する</button></form>'
                    . '<details><summary>申請について</summary><p>共有URLのサーバーを引き継ぎます。別のサーバーにも申請できます。申請後は「申請状況」で返信を確認してください。</p></details>';
            } elseif (!$super) {
                $html .= '<p>表示名登録後に申請できます。編集停止中は申請できません。</p>';
            }
            $html .= '</section>';
        }
        if ($tab === 'profile') {
            $name = $user['display_name'] ?? ($_SESSION['suggested_name'] ?? '');
            $html .= '<section><h2>公開する表示名</h2>' . accountForm($config, '/account/name')
                . '<label>表示名<input name="name" maxlength="80" required value="' . escape($name) . '"></label>'
                . '<p>同名は使用可能です。確定した表示名は編集履歴に公開されます。</p>'
                . '<button>表示名を保存</button></form><details><summary>識別名・プライバシー</summary><p>識別名：'
                . escape($user['id']) . '（変更できません）</p><p>Googleのメールアドレスは要求・保存しません。</p></details></section>';
        }
        if ($tab === 'notifications') {
            $notifications = array_reverse(array_values(array_filter($access['notifications'],
                static fn(array $item): bool => $item['user_id'] === $user['id'])));
            $html .= '<section id="notifications"><h2>通知（未読 ' . unreadAccessCount($access, $user['id']) . '件）</h2>';
            if ($notifications !== []) {
                $html .= accountForm($config, '/account/read', ['through' => count($access['notifications'])])
                    . '<button>通知をすべて既読にする</button></form>';
            } else {
                $html .= '<p>通知はありません。</p>';
            }
            foreach (array_slice($notifications, 0, 20) as $item) {
                $html .= '<p>' . ($item['id'] > ($access['read_through'][$user['id']] ?? 0) ? '<span class="badge">未読</span> ' : '')
                    . escape($item['text']) . '<br><small>' . accountDate($item['created_at']) . '</small></p>';
            }
            $html .= '<details><summary>通知について</summary><p>最新20件を表示。最新状態と返信は「申請状況」で確認できます。'
                . 'メール・プッシュ通知は送信されません。既読化しても申請は処理されません。</p></details></section>';
        }
        if ($tab === 'requests') {
            $html .= '<section id="requests"><h2>自分の申請一覧</h2><p>保留は審査継続中、却下後は再申請できます。</p>';
            $requests = array_reverse(array_values(array_filter($access['requests'],
                static fn(array $request): bool => $request['user_id'] === $user['id'])));
            [$requests, $pagination] = accountPagination($requests);
            foreach ($requests as $request) {
                $html .= accountRequestCard($request, $byId) . '</details></article>';
            }
            if ($requests === []) {
                $html .= '<p>申請はありません。「編集権限」から申請できます。</p>';
            }
            $html .= $pagination . '</section>';
        }
        page('アカウント', $html . '</main></div>');
    } catch (InvalidArgumentException $error) {
        page('入力を確認してください', '<p>' . escape($error->getMessage()) . '</p>', 400);
    }
}

function renderAdmin(array $config, array $actor, array $users, array $access, string $server, bool $super): string
{
    $tab = accountQuery('tab', 'requests');
    if (!in_array($tab, ['requests', 'users'], true)) {
        throw new InvalidArgumentException('管理メニューを選び直してください。');
    }
    $query = accountQuery('q');
    $status = accountQuery('status', $tab === 'users' ? '' : 'open');
    $sort = accountQuery('sort', 'newest');
    $html = '<nav class="account-tabs admin-tabs" aria-label="管理メニュー"><a href="?view=admin"'
        . ($tab === 'requests' ? ' aria-current="page"' : '') . '>申請管理</a><a href="?view=admin&amp;tab=users"'
        . ($tab === 'users' ? ' aria-current="page"' : '') . '>利用者・権限</a></nav>'
        . '<details class="filter-options"' . ($query !== '' || $server !== '' || isset($_GET['status']) || isset($_GET['sort']) ? ' open' : '')
        . '><summary>検索・絞り込み・並べ替え</summary><form method="get" class="filters"><input type="hidden" name="view" value="admin">'
        . '<input type="hidden" name="tab" value="' . escape($tab) . '">'
        . '<label>検索<input name="q" value="' . escape($query) . '" placeholder="表示名・識別名"></label>'
        . '<label>サーバー番号<input name="server" value="' . escape($server) . '"></label>'
        . '<label>状態<select name="status">';
    $statuses = $tab === 'users' ? ['' => 'すべて', 'active' => '編集停止なし', 'suspended' => '編集停止中']
        : ['open' => '未処理（申請中・保留）', '' => 'すべて', 'pending' => '申請中',
            'held' => '保留', 'approved' => '承認済み', 'rejected' => '却下'];
    foreach ($statuses as $value => $label) {
        $html .= '<option value="' . escape($value) . '"' . ($status === $value ? ' selected' : '') . '>' . $label . '</option>';
    }
    $html .= '</select></label><label>並べ替え<select name="sort">';
    foreach (['newest' => '日時の新しい順', 'oldest' => '日時の古い順', 'name' => '表示名順'] as $value => $label) {
        $html .= '<option value="' . $value . '"' . ($sort === $value ? ' selected' : '') . '>' . $label . '</option>';
    }
    $html .= '</select></label><button>絞り込む</button><a href="?view=admin&amp;tab=' . $tab . '">条件をリセット</a></form></details>';
    $byId = array_column($users, null, 'id');
    $matches = static fn(array $user): bool => $query === ''
        || stripos(($user['display_name'] ?? '') . ' ' . $user['id'], $query) !== false;
    if ($tab !== 'users') {
        $items = array_values(array_filter($access['requests'], static fn(array $request): bool =>
            canApproveServer($actor, $request['server'], $config, $access)
            && ($server === '' || $request['server'] === $server)
            && ($status === '' || ($status === 'open' ? in_array($request['status'], ['pending', 'held'], true) : $request['status'] === $status))
            && isset($byId[$request['user_id']]) && $matches($byId[$request['user_id']])));
        usort($items, static fn(array $a, array $b): int => $sort === 'name'
            ? strcmp($byId[$a['user_id']]['display_name'] ?? '', $byId[$b['user_id']]['display_name'] ?? '')
            : ($sort === 'oldest' ? 1 : -1) * strcmp($a['created_at'], $b['created_at']));
        [$items, $pagination] = accountPagination($items);
        $html .= '<h2>申請管理</h2><p>通知の既読と申請の処理は別です。保留・却下には返信が必要です。</p>';
        foreach ($items as $request) {
            $html .= accountRequestCard($request, $byId);
            if (in_array($request['status'], ['pending', 'held'], true)) {
                $html .= accountForm($config, '/admin/decision', ['request' => $request['id']])
                    . '<label>返信メッセージ<textarea name="message" maxlength="1000" rows="3"></textarea></label>'
                    . '<button name="status" value="approved">承認</button> '
                    . '<button name="status" value="held">保留</button> '
                    . '<button name="status" value="rejected" class="danger">却下</button></form>';
            }
            $html .= '</details></article>';
        }
        if ($items === []) {
            $html .= '<p>条件に一致する申請はありません。</p>';
        }
        return $html . $pagination;
    }
    $items = array_values(array_filter($users, static fn(array $user): bool => $matches($user)
        && ($status === '' || ($status === 'suspended' ? $user['suspended'] : !$user['suspended']))
        && ($server === '' || isset($access['permissions'][$user['id']][$server]))
        && ($super || count(array_filter(array_keys($access['permissions'][$user['id']] ?? []),
            static fn(string $id): bool => canApproveServer($actor, $id, $config, $access))) > 0)));
    usort($items, static fn(array $a, array $b): int => $sort === 'name'
        ? strcmp($a['display_name'] ?? '', $b['display_name'] ?? '')
        : ($sort === 'oldest' ? 1 : -1) * strcmp($a['registered_at'] ?? '', $b['registered_at'] ?? ''));
    [$items, $pagination] = accountPagination($items);
    $html .= '<h2>利用者・権限管理</h2><p>権限変更は保存ボタンで確定します。チェックを外すと取り消しになります。全体の編集停止とは別です。</p>';
    foreach ($items as $user) {
        $html .= '<article><details name="user-detail"><summary>' . escape($user['display_name'] ?? '表示名未登録')
            . ' · ' . (isAdmin($user, $config) ? '最高管理者' : ($user['suspended'] ? '編集停止中' : '編集停止なし')) . '</summary>'
            . '<p>' . escape($user['id']) . '<br>登録日時：' . accountDate($user['registered_at'])
            . '<br>' . (isAdmin($user, $config) ? '最高管理者' : ($user['suspended'] ? '編集停止中' : '編集停止なし')) . '</p>';
        foreach ($access['permissions'][$user['id']] ?? [] as $id => $roles) {
            if (!$super && !canApproveServer($actor, $id, $config, $access)) {
                continue;
            }
            $html .= '<p>' . escape($id) . '：編集 ' . ($roles['editor'] ? '可' : '不可')
                . ' / 承認 ' . ($roles['approver'] ? '可' : '不可') . '</p>'
                . accountForm($config, '/admin/roles', ['target' => $user['id'], 'server' => $id])
                . '<label class="check"><input type="checkbox" name="editor" value="1"' . ($roles['editor'] ? ' checked' : '') . '>編集者</label>'
                . ($super ? '<label class="check"><input type="checkbox" name="approver" value="1"' . ($roles['approver'] ? ' checked' : '') . '>承認者</label>' : '')
                . '<button>このサーバーの権限を保存</button></form>';
        }
        if ($super && !isAdmin($user, $config)) {
            $html .= '<details><summary>別サーバーの権限を設定</summary>'
                . accountForm($config, '/admin/roles', ['target' => $user['id']])
                . '<label>サーバー番号<input name="server" required pattern="(?:S)?[0-9]{1,10}"></label>'
                . '<label class="check"><input type="checkbox" name="editor" value="1">編集者</label>'
                . '<label class="check"><input type="checkbox" name="approver" value="1">承認者</label>'
                . '<button>権限を保存</button></form></details>'
                . '<details><summary>編集停止の管理</summary><p>全サーバーの編集・申請・承認を停止します。管理者の停止はこの画面ではできません。</p>'
                . accountForm($config, '/admin/suspension', ['target' => $user['id'], 'stop' => $user['suspended'] ? '0' : '1'])
                . '<button class="danger">' . ($user['suspended'] ? '編集停止を解除' : '編集を停止') . '</button></form></details>';
        }
        $html .= '</details></article>';
    }
    if ($items === []) {
        $html .= '<p>条件に一致する利用者はいません。</p>';
    }
    return $html . $pagination;
}
