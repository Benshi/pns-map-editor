<?php
declare(strict_types=1);

final class MapConflict extends RuntimeException {}

function emptySharedMap(): array
{
    return ['version' => 1, 'ownGuildId' => null, 'guilds' => [], 'facilities' => [], 'mountains' => []];
}

function registeredMapServers(string $private, array $configured): array
{
    $servers = $configured;
    $root = $private . DIRECTORY_SEPARATOR . 'maps';
    if (is_dir($root)) {
        foreach (new DirectoryIterator($root) as $entry) {
            $id = $entry->getFilename();
            if ($entry->isDir() && preg_match('/^S[0-9]{1,10}$/D', $id)
                && is_file($entry->getPathname() . DIRECTORY_SEPARATOR . 'head.json')) {
                $servers[] = $id;
            }
        }
    }
    $servers = array_values(array_unique($servers));
    sort($servers, SORT_NATURAL);
    return $servers;
}

function mapShareCode(string $directory, bool $create = false): ?string
{
    $path = $directory . DIRECTORY_SEPARATOR . 'share-code.json';
    if (!$create && !is_file($path)) {
        return null;
    }
    $lock = fopen($directory . DIRECTORY_SEPARATOR . 'share.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException('Could not open sharing lock.');
    }
    try {
        if (!flock($lock, LOCK_EX)) {
            throw new RuntimeException('Could not lock map sharing.');
        }
        if (is_file($path)) {
            $code = json_decode(file_get_contents($path), true, 8, JSON_THROW_ON_ERROR);
            if (!is_string($code) || !preg_match('/^[A-Za-z0-9_-]{12}$/D', $code)) {
                throw new RuntimeException('Invalid map sharing code.');
            }
            return $code;
        }
        if (!$create) {
            return null;
        }
        $code = strtr(base64_encode(random_bytes(9)), '+/', '-_');
        atomicMapWrite($directory, 'share-code.json', json_encode($code, JSON_THROW_ON_ERROR));
        return $code;
    } finally {
        fclose($lock);
    }
}

function sharedCodeServer(string $private, array $servers, string $code): ?string
{
    if (!preg_match('/^[A-Za-z0-9_-]{12}$/D', $code)) {
        return null;
    }
    $found = null;
    foreach ($servers as $server) {
        $saved = mapShareCode($private . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . $server);
        if ($saved !== null && hash_equals($saved, $code)) {
            if ($found !== null) {
                throw new RuntimeException('Duplicate map sharing code.');
            }
            $found = $server;
        }
    }
    return $found;
}

function mapText(mixed $value): string
{
    if (!is_string($value) || trim($value) === '' || strlen($value) > 320
        || preg_match('//u', $value) !== 1 || preg_match_all('/./us', $value) > 80) {
        throw new InvalidArgumentException('名前・IDは1〜80文字にしてください。');
    }
    return trim($value);
}

function mapCell(int $x, int $y): bool
{
    return $x >= 0 && $x <= 511 && $y >= 0 && $y <= 1023 && $x % 2 === $y % 2;
}

function mapPolygon(int $x, int $y, array $vertices): bool
{
    $inside = false;
    for ($i = 0, $j = count($vertices) - 1; $i < count($vertices); $j = $i++) {
        [$ax, $ay] = $vertices[$j];
        [$bx, $by] = $vertices[$i];
        if (($x - $ax) * ($by - $ay) === ($y - $ay) * ($bx - $ax)
            && $x >= min($ax, $bx) && $x <= max($ax, $bx)
            && $y >= min($ay, $by) && $y <= max($ay, $by)) {
            return true;
        }
        if (($ay > $y) !== ($by > $y) && $x < ($bx - $ax) * ($y - $ay) / ($by - $ay) + $ax) {
            $inside = !$inside;
        }
    }
    return $inside;
}

function validateSharedMap(mixed $raw): array
{
    if (!is_array($raw) || ($raw['version'] ?? null) !== 1) {
        throw new InvalidArgumentException('対応するマップJSONではありません。');
    }
    foreach (['guilds' => 100, 'facilities' => 11100, 'mountains' => 10000] as $key => $limit) {
        if (!is_array($raw[$key] ?? null) || !array_is_list($raw[$key]) || count($raw[$key]) > $limit) {
            throw new InvalidArgumentException('データ形式または件数が不正です。');
        }
    }
    $map = emptySharedMap();
    $ids = [];
    $id = static function (mixed $value) use (&$ids): string {
        $clean = mapText($value);
        if (isset($ids[$clean])) {
            throw new InvalidArgumentException('IDが重複しています。');
        }
        $ids[$clean] = true;
        return $clean;
    };
    $members = [];
    $names = [];
    foreach ($raw['guilds'] as $guild) {
        if (!is_array($guild)) {
            throw new InvalidArgumentException('ギルドが不正です。');
        }
        $gid = $id($guild['id'] ?? null);
        $name = mapText($guild['name'] ?? null);
        if (isset($names[$name]) || !is_array($guild['members'] ?? null)
            || !array_is_list($guild['members'])) {
            throw new InvalidArgumentException('ギルド名またはメンバー一覧が不正です。');
        }
        $names[$name] = true;
        $cleanMembers = [];
        $memberNames = [];
        $members[$gid] = [];
        foreach ($guild['members'] as $member) {
            if (!is_array($member)) {
                throw new InvalidArgumentException('メンバーが不正です。');
            }
            $mid = $id($member['id'] ?? null);
            $memberName = mapText($member['name'] ?? null);
            if (isset($memberNames[$memberName])) {
                throw new InvalidArgumentException('メンバー名が重複しています。');
            }
            $memberNames[$memberName] = true;
            $members[$gid][$mid] = true;
            $cleanMembers[] = ['id' => $mid, 'name' => $memberName];
            $rank = $member['rank'] ?? null;
            if ($rank !== null) {
                if (!is_int($rank) || $rank < 1 || $rank > 5) {
                    throw new InvalidArgumentException('メンバーのランクが不正です。');
                }
                $cleanMembers[array_key_last($cleanMembers)]['rank'] = $rank;
            }
        }
        $map['guilds'][] = ['id' => $gid, 'name' => $name, 'members' => $cleanMembers];
    }
    $occupied = [];
    $unique = [];
    $lab = [[244,512],[256,524],[268,512],[256,500]];
    $wasteland = [[217,511],[256,472],[295,511],[256,550]];
    foreach (['mountains', 'facilities'] as $list) {
        foreach ($raw[$list] as $source) {
            if (!is_array($source) || !is_int($source['x'] ?? null) || !is_int($source['y'] ?? null)
                || !in_array($source['type'] ?? null, $list === 'mountains' ? ['mountain']
                    : ['fortress','resource','trap','warehouse','hospital','shelter',
                        'outpost1','outpost2','outpost3','outpost4','outpost5'], true)
                || ($source['size'] ?? null) !== (str_starts_with($source['type'], 'outpost') ? 1 : 2)) {
                throw new InvalidArgumentException('施設の種類・サイズ・座標が不正です。');
            }
            $object = ['id' => $id($source['id'] ?? null), 'type' => $source['type'],
                'size' => $source['size'], 'x' => $source['x'], 'y' => $source['y']];
            $x = $object['x'];
            $y = $object['y'];
            $cells = $object['size'] === 1 ? [[$x,$y]] : [[$x,$y],[$x-1,$y-1],[$x,$y-2],[$x+1,$y-1]];
            foreach ($cells as [$cx,$cy]) {
                $key = "$cx,$cy";
                if (!mapCell($cx, $cy) || isset($occupied[$key])
                    || mapPolygon($cx, $cy, $lab)
                    || (mapPolygon($cx, $cy, $wasteland)
                        && ($list === 'mountains' || ($list === 'facilities' && $source['type'] !== 'shelter')))) {
                    throw new InvalidArgumentException('施設が範囲外・禁止地形・他の施設と重複しています。');
                }
                $occupied[$key] = true;
            }
            if ($list === 'facilities') {
                $gid = $source['guildId'] ?? null;
                if (!is_string($gid) || !isset($members[$gid])) {
                    throw new InvalidArgumentException('所属ギルドが不正です。');
                }
                $object['guildId'] = $gid;
                $mid = null;
                if ($object['type'] === 'shelter') {
                    $mid = $source['memberId'] ?? null;
                    if (!is_string($mid) || !isset($members[$gid][$mid])) {
                        throw new InvalidArgumentException('所属メンバーが不正です。');
                    }
                    $object['memberId'] = $mid;
                }
                $key = json_encode([$gid, $object['type'], $mid], JSON_THROW_ON_ERROR);
                if (isset($unique[$key])) {
                    throw new InvalidArgumentException('施設または避難所が重複しています。');
                }
                $unique[$key] = true;
            }
            $map[$list][] = $object;
        }
    }
    $map['ownGuildId'] = $map['guilds'][0]['id'] ?? null;
    return $map;
}

function mapDirectory(string $private, string $server): string
{
    if (!preg_match('/^S[0-9]{1,10}$/D', $server)) {
        throw new InvalidArgumentException('サーバーIDが不正です。');
    }
    $directory = $private . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . $server;
    $lock = fopen($private . DIRECTORY_SEPARATOR . 'maps.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException('Could not open directory lock.');
    }
    try {
        if (!flock($lock, LOCK_EX)) {
            throw new RuntimeException('Could not lock map directories.');
        }
        if (!is_dir($directory) && !mkdir($directory, 0700, true)) {
            throw new RuntimeException('Could not create map directory.');
        }
    } finally {
        fclose($lock);
    }
    return $directory;
}

function readMapRevision(string $directory, string $file): array
{
    if (!preg_match('/^revision-[a-f0-9]{32}\.json$/D', $file)) {
        throw new RuntimeException('Invalid revision reference.');
    }
    $revision = json_decode(file_get_contents($directory . DIRECTORY_SEPARATOR . $file),
        true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($revision) || !is_int($revision['revision'] ?? null)
        || $revision['revision'] < 1 || !is_array($revision['map'] ?? null)
        || !is_array($revision['author'] ?? null) || !is_string($revision['saved_at'] ?? null)
        || !array_key_exists('parent', $revision)
        || ($revision['parent'] !== null && !is_string($revision['parent']))) {
        throw new RuntimeException('Invalid saved revision.');
    }
    return $revision;
}

function emptyMapRevision(): array
{
    return ['revision' => 0, 'map' => emptySharedMap(), 'saved_at' => null,
        'author' => null, 'file' => null, 'parent' => null, 'restored_from' => null];
}

function currentMap(string $directory): array
{
    $head = $directory . DIRECTORY_SEPARATOR . 'head.json';
    if (!file_exists($head)) {
        return emptyMapRevision();
    }
    $file = json_decode(file_get_contents($head), true, 8, JSON_THROW_ON_ERROR);
    if (!is_string($file)) {
        throw new RuntimeException('Invalid map head.');
    }
    return readMapRevision($directory, $file) + ['file' => $file];
}

function findMapRevision(string $directory, int $number): array
{
    $revision = currentMap($directory);
    while ($revision['revision'] > $number && $revision['parent'] !== null) {
        $revision = readMapRevision($directory, $revision['parent']);
    }
    if ($number < 1 || $revision['revision'] !== $number) {
        throw new InvalidArgumentException('指定された版が見つかりません。');
    }
    return $revision;
}

function publicRevision(array $revision, bool $withMap = true): array
{
    $result = array_intersect_key($revision, array_flip([
        'revision', 'saved_at', 'author', 'restored_from',
    ]));
    if ($withMap) {
        $result['map'] = $revision['map'];
    }
    return $result;
}

function atomicMapWrite(string $directory, string $name, string $content): void
{
    $temporary = $directory . DIRECTORY_SEPARATOR . 'write-' . bin2hex(random_bytes(16)) . '.tmp';
    try {
        if (file_put_contents($temporary, $content) !== strlen($content)
            || !rename($temporary, $directory . DIRECTORY_SEPARATOR . $name)) {
            throw new RuntimeException('Could not persist map.');
        }
    } finally {
        if (file_exists($temporary) && !unlink($temporary)) {
            throw new RuntimeException('Could not remove map temporary file.');
        }
    }
}

function saveSharedMap(string $private, string $server, int $base, mixed $map, string $userId,
    ?int $restore = null): array
{
    $directory = mapDirectory($private, $server);
    // Lock order is users then map, so a suspension cannot race a successful save.
    $usersLock = fopen($private . DIRECTORY_SEPARATOR . 'users.lock', 'c');
    if ($usersLock === false) {
        throw new RuntimeException('Could not open users lock.');
    }
    $lock = null;
    try {
        if (!flock($usersLock, LOCK_SH)) {
            throw new RuntimeException('Could not lock users registry.');
        }
        $author = null;
        foreach (readUsers($private . DIRECTORY_SEPARATOR . 'users.json') as $user) {
            if ($user['id'] === $userId && canEdit($user)) {
                $author = ['id' => $user['id'], 'display_name' => $user['display_name']];
            }
        }
        if ($author === null) {
            throw new InvalidArgumentException('表示名登録が必要、または編集停止中です。');
        }
        $lock = fopen($directory . DIRECTORY_SEPARATOR . 'save.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            throw new RuntimeException('Could not lock map.');
        }
        $current = currentMap($directory);
        if ($base !== $current['revision']) {
            throw new MapConflict('他の人が更新しました。変更をJSONに退避して最新版を読み込んでください。');
        }
        $validated = validateSharedMap($restore === null ? $map : findMapRevision($directory, $restore)['map']);
        $revision = ['revision' => $base + 1, 'saved_at' => gmdate('Y-m-d\TH:i:s\Z'),
            'author' => $author, 'restored_from' => $restore, 'parent' => $current['file'],
            'map' => $validated];
        $file = 'revision-' . bin2hex(random_bytes(16)) . '.json';
        atomicMapWrite($directory, $file, json_encode($revision, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        atomicMapWrite($directory, 'head.json', json_encode($file, JSON_THROW_ON_ERROR));
        return publicRevision($revision);
    } finally {
        if (is_resource($lock)) {
            fclose($lock);
        }
        fclose($usersLock);
    }
}
