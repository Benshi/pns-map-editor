<?php
declare(strict_types=1);

if (getenv('PNS_AUTH_TEST_WORKER') === '1') {
    $request = json_decode(getenv('PNS_AUTH_TEST_REQUEST'), true, 16, JSON_THROW_ON_ERROR);
    $_SERVER['DOCUMENT_ROOT'] = getenv('PNS_AUTH_TEST_ROOT') . DIRECTORY_SEPARATOR . 'www';
    $_SERVER['HTTPS'] = $request['https'] ?? 'on';
    $_SERVER['REQUEST_METHOD'] = $request['method'] ?? 'GET';
    $_SERVER['PATH_INFO'] = $request['route'] ?? '';
    $_POST = $request['post'] ?? [];
    $_GET = $request['query'] ?? [];
    if (isset($request['session'])) {
        $_COOKIE['pns_map_session_v2'] = $request['session'];
    }
    register_shutdown_function(static function (): void {
        echo "\nPNS_TEST_RESULT:" . json_encode([
            'status' => http_response_code() ?: 200,
            'session' => session_id(),
            'state' => $_SESSION ?? [],
        ], JSON_THROW_ON_ERROR);
    });
    require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'api.php';
    exit;
}

function expect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'pns-api-test-' . bin2hex(random_bytes(16));
$private = $root . DIRECTORY_SEPARATOR . 'pns-map-private';
umask(0077);
expect(mkdir($root, 0700), 'Could not create fixture.');
expect(mkdir($root . DIRECTORY_SEPARATOR . 'www', 0700), 'Could not create document root.');
expect(mkdir($private, 0700), 'Could not create private root.');
putenv('PNS_AUTH_TEST_ROOT=' . $root);
putenv('PNS_MAP_PRIVATE_DIR=' . $private);
$request = static function (array $input): array {
    putenv('PNS_AUTH_TEST_WORKER=1');
    putenv('PNS_AUTH_TEST_REQUEST=' . json_encode($input, JSON_THROW_ON_ERROR));
    $process = proc_open([PHP_BINARY, __FILE__], [
        0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w'],
    ], $pipes);
    expect(is_resource($process), 'Could not start worker.');
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    expect(proc_close($process) === 0, 'Worker failed: ' . $errors);
    $parts = explode("\nPNS_TEST_RESULT:", $output);
    expect(count($parts) === 2, 'Worker did not return test metadata.');
    return ['html' => $parts[0]] + json_decode($parts[1], true, 32, JSON_THROW_ON_ERROR);
};
try {
    $result = $request(['https' => 'off']);
    expect($result['status'] === 400, 'Accepted HTTP.');
    $result = $request([]);
    expect($result['status'] === 500 && !str_contains($result['html'], $root),
        'Missing configuration leaked or did not fail closed.');
    $config = ['redirect_uri' => 'https://example.com/pns-map/api.php/auth/callback',
        'admin_user_id' => null];
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'config.php',
        '<?php return ' . var_export($config, true) . ';') !== false, 'Config fixture failed.');
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'google-client.json', json_encode([
        'web' => ['client_id' => 'test-client', 'client_secret' => 'fixture-secret',
            'redirect_uris' => [$config['redirect_uri']]],
    ], JSON_THROW_ON_ERROR)) !== false, 'OAuth fixture failed.');
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'users.json', json_encode([
        ['sub' => '123456', 'email' => 'private@example.com', 'servers' => ['S1047' => 'admin']],
        ['sub' => '234567', 'email' => 'other@example.com', 'servers' => []],
    ], JSON_THROW_ON_ERROR)) !== false, 'Legacy fixture failed.');
    $result = $request([]);
    expect($result['status'] === 200 && str_contains($result['html'], 'Google でログイン'),
        'Login page failed.');
    expect(!str_contains($result['html'], 'fixture-secret'), 'Secret leaked.');
    expect(str_contains($result['html'], 'href="https://example.com/pns-map/index.html">マップに戻る'),
        'Anonymous login page has no map return link.');
    $result = $request(['query' => ['return' => 'map=Abc123_-xyzQ&guild=AbC&scale=14']]);
    expect(str_contains($result['html'],
        'href="https://example.com/pns-map/index.html?map=Abc123_-xyzQ&amp;guild=AbC&amp;scale=14">マップに戻る'),
        'Map return lost shared code, case or scale.');
    $returnSession = $result['session'];
    $result = $request(['session' => $returnSession]);
    expect(str_contains($result['html'], 'map=Abc123_-xyzQ&amp;guild=AbC'),
        'Map return was not retained on account reload.');
    $result = $request(['query' => ['return' => '"><script>alert(1)</script>']]);
    expect(!str_contains($result['html'], '<script>') && str_contains($result['html'], '&lt;script&gt;'),
        'Map return link was not escaped.');
    $result = $request(['query' => ['return' => "map=bad\n"]]);
    expect($result['status'] === 400, 'Control character in return accepted.');
    $result = $request(['query' => ['return' => ['invalid']]]);
    expect($result['status'] === 400, 'Invalid map return accepted.');
    $result = $request([]);
    $users = json_decode(file_get_contents($private . DIRECTORY_SEPARATOR . 'users.json'),
        true, 32, JSON_THROW_ON_ERROR);
    expect(!isset($users[0]['email']) && $users[0]['admin'], 'Migration failed.');
    $session = $result['session'];
    $csrf = $result['state']['csrf'];
    $result = $request(['route' => '/maps']);
    expect($result['status'] === 403, 'Anonymous server catalog exposed.');
    $result = $request(['route' => '/maps/S1063']);
    expect($result['status'] === 403, 'Unscoped anonymous read allowed.');
    $result = $request(['route' => '/maps/S1063', 'query' => ['server' => 'S1063']]);
    expect($result['status'] === 403, 'Code-free registered read allowed.');
    $result = $request(['route' => '/maps/S1063', 'method' => 'POST',
        'query' => ['server' => 'S1063'],
        'post' => ['csrf' => $csrf, 'payload' => '{}']]);
    expect($result['status'] === 403, 'Anonymous save allowed.');
    $result = $request(['route' => '/maps/S999', 'query' => ['server' => 'S999']]);
    expect($result['status'] === 403, 'Anonymous server guessing allowed.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/auth/login']);
    expect($result['status'] === 403 && !isset($result['state']['oauth']), 'Accepted missing CSRF.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/auth/login',
        'post' => ['csrf' => $csrf]]);
    expect($result['status'] === 303 && isset($result['state']['oauth']['verifier']),
        'OAuth start failed.');
    $state = $result['state']['oauth']['state'];
    $result = $request(['session' => $session, 'route' => '/auth/callback',
        'query' => ['state' => 'incorrect', 'code' => 'unused']]);
    expect($result['status'] === 403 && !isset($result['state']['identity'])
        && !isset($result['state']['oauth']), 'Accepted invalid callback.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/auth/login',
        'post' => ['csrf' => $csrf]]);
    $state = $result['state']['oauth']['state'];
    $result = $request(['session' => $session, 'route' => '/auth/callback',
        'query' => ['state' => $state, 'error' => 'access_denied']]);
    expect($result['status'] === 200 && str_contains($result['html'], 'キャンセル')
        && !isset($result['state']['identity']), 'Cancellation failed.');
    $result = $request(['session' => $session, 'route' => '/auth/callback',
        'query' => ['state' => $state, 'code' => 'unused']]);
    expect($result['status'] === 403, 'Replayed callback accepted.');
    $seed = static function (string $id) use ($session, $csrf, $private): void {
        $data = 'identity|' . serialize($id) . 'expires|' . serialize(time() + 3600)
            . 'csrf|' . serialize($csrf) . 'suggested_name|' . serialize('<script>alert(1)</script>');
        expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'sessions-v2'
            . DIRECTORY_SEPARATOR . 'sess_' . $session, $data) !== false, 'Session fixture failed.');
    };
    $seed($users[0]['id']);
    $result = $request(['session' => $session]);
    expect(str_contains($result['html'], '&lt;script&gt;alert(1)&lt;/script&gt;')
        && !str_contains($result['html'], '<script>'), 'Suggested profile name was not escaped.');
    $result = $request(['session' => $session, 'route' => '/session']);
    expect(json_decode($result['html'], true)['user']['admin'], 'Administrator flag missing.');
    $result = $request(['session' => $session, 'query' => ['view' => 'admin', 'tab' => 'users']]);
    expect(str_contains($result['html'], '登録日時：'), 'Registration date label missing.');
    expect(str_contains($result['html'], '登録日時：不明'), 'Unknown registration date was not labeled.');
    $users[1]['registered_at'] = '2026-10-13T16:05:52Z';
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'users.json',
        json_encode($users, JSON_THROW_ON_ERROR)) !== false, 'Registration date fixture failed.');
    $result = $request(['session' => $session, 'query' => ['view' => 'admin', 'tab' => 'users']]);
    expect(str_contains($result['html'], '登録日時：2026-10-14 01:05（日本時間）'),
        'Registration date was not displayed in Japan time.');
    $result = $request(['session' => $session, 'route' => '/maps']);
    expect(json_decode($result['html'], true)['servers'] === ['S1063'], 'Admin catalog failed.');
    $directory = $private . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . 'S1063';
    expect(mkdir($directory, 0700, true), 'Legacy sharing fixture directory failed.');
    expect(file_put_contents($directory . DIRECTORY_SEPARATOR . 'share.json',
        json_encode(str_repeat('a', 64))) !== false, 'Legacy sharing fixture failed.');
    $result = $request(['session' => $session, 'query' => ['view' => 'admin', 'tab' => 'users']]);
    expect(str_contains($result['html'], '編集停止の管理')
        && !str_contains($result['html'], '123456') && !str_contains($result['html'], 'private@example.com'),
        'Admin page leaked identity or profile was not escaped.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/name',
        'post' => ['csrf' => $csrf, 'name' => 'Same Name']]);
    expect($result['status'] === 303 && !isset($result['state']['suggested_name']), 'Name registration failed.');
    $map = ['version' => 2, 'ownGuildId' => null, 'guilds' => [], 'players' => [], 'facilities' => [], 'mountains' => []];
    $legacyMap = ['version' => 1, 'ownGuildId' => null, 'guilds' => [], 'facilities' => [], 'mountains' => []];
    $save = ['session' => $session, 'method' => 'POST', 'route' => '/maps/S1063',
        'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 0, 'map' => $legacyMap])]];
    $result = $request($save);
    expect($result['status'] === 200 && json_decode($result['html'], true)['revision'] === 1,
        'Registered user save failed: ' . $result['status'] . ' ' . $result['html']);
    $code = json_decode($result['html'], true)['code'];
    expect(preg_match('/^[A-Za-z0-9_-]{12}$/D', $code) === 1, 'Sharing code invalid.');
    $query = ['map' => $code];
    $result = $request(['route' => '/maps', 'query' => $query]);
    expect(json_decode($result['html'], true)['servers'] === ['S1063'], 'Single server catalog failed.');
    expect(json_decode($result['html'], true)['server'] === 'S1063', 'Code server resolution failed.');
    $result = $request(['route' => '/maps/S1063', 'query' => ['map' => 'invalid-code']]);
    expect($result['status'] === 403, 'Incorrect code accepted.');
    $result = $request(['route' => '/maps/S1063', 'query' => ['server' => 'S1063', 'hash' => str_repeat('a', 64)]]);
    expect($result['status'] === 403, 'Legacy hash still grants access.');
    $result = $request(['route' => '/maps/S1063', 'query' => $query]);
    expect($result['status'] === 200 && json_decode($result['html'], true)['map'] === $map,
        'Short code read failed.');
    $result = $request(['route' => '/maps/S1047', 'query' => $query]);
    expect($result['status'] === 403, 'Cross-server read accepted.');
    $result = $request($save);
    expect($result['status'] === 409, 'API accepted stale save.');
    $result = $request(['route' => '/maps/S1063/history', 'query' => $query]);
    expect(count(json_decode($result['html'], true)['history']) === 1, 'History route failed.');
    $result = $request(['route' => '/maps/S1063/revisions/1', 'query' => $query]);
    expect(json_decode($result['html'], true)['map'] === $map, 'Revision route failed.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/maps/S1063/restore',
        'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 1, 'restore_revision' => 1])]]);
    expect($result['status'] === 200 && json_decode($result['html'], true)['revision'] === 2,
        'Restore route failed.');
    expect(json_decode($result['html'], true)['code'] === $code, 'Restore changed shared URL.');
    $result = $request(['route' => '/maps/S1063/history', 'query' => ['server' => 'S1063']]);
    expect($result['status'] === 403, 'Code-free history exposed.');
    $result = $request(['route' => '/maps/S1063/revisions/1', 'query' => ['server' => 'S1063']]);
    expect($result['status'] === 403, 'Code-free past revision exposed.');
    $seed($users[1]['id']);
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/name',
        'post' => ['csrf' => $csrf, 'name' => 'Builder']]);
    expect($result['status'] === 303, 'Editor name registration failed.');
    $result = $request(['session' => $session, 'route' => '/session']);
    expect(!json_decode($result['html'], true)['user']['can_edit'], 'Legacy profile inherited edit access.');
    $result = $request(['session' => $session, 'query' => ['view' => 'admin']]);
    expect($result['status'] === 403, 'General user accessed administration.');
    $result = $request(['session' => $session, 'route' => '/maps/S1063', 'query' => ['server' => 'S1063']]);
    expect($result['status'] === 403, 'Unapproved user bootstrapped map.');
    $result = $request(['session' => $session, 'route' => '/maps/S1063', 'query' => $query]);
    expect($result['status'] === 200, 'Unapproved user could not view shared map.');
    $result = $request(['session' => $session, 'query' => ['return' => 'map=' . $code]]);
    expect(str_contains($result['html'], 'value="S1063"')
        && !str_contains($result['html'], '<h2>管理者'), 'Account lost server context or exposed administration.');
    expect(substr_count($result['html'], '>ログアウト</button>') === 1
        && strpos($result['html'], '>ログアウト</button>') < strpos($result['html'], '<main ')
        && !str_contains($result['html'], 'name="name"')
        && !str_contains($result['html'], 'id="notifications"')
        && !str_contains($result['html'], 'id="requests"'), 'Account mixed panels or hid logout below content.');
    $result = $request(['session' => $session, 'query' => ['tab' => 'profile']]);
    expect(str_contains($result['html'], 'name="name"')
        && !str_contains($result['html'], 'name="message"'), 'Profile panel did not isolate name settings.');
    $result = $request(['session' => $session, 'query' => ['tab' => 'notifications']]);
    expect(str_contains($result['html'], 'id="notifications"')
        && str_contains($result['html'], '通知はありません。')
        && !str_contains($result['html'], 'name="name"'), 'Notification panel failed.');
    $result = $request(['session' => $session, 'query' => ['tab' => 'requests']]);
    expect(str_contains($result['html'], 'id="requests"')
        && !str_contains($result['html'], 'name="message"'), 'Request history mixed application form.');
    $result = $request(['session' => $session, 'query' => ['tab' => 'invalid']]);
    expect($result['status'] === 400, 'Unknown account panel silently accepted.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/maps/S1063',
        'query' => $query, 'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 2, 'map' => $map])]]);
    expect($result['status'] === 403, 'Unapproved user saved through shared URL.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/maps/S1063/restore',
        'query' => $query, 'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 2, 'restore_revision' => 1])]]);
    expect($result['status'] === 403, 'Unapproved user restored past revision.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/request',
        'post' => ['csrf' => 'invalid', 'server' => '1063', 'message' => 'Apply']]);
    expect($result['status'] === 403, 'Application bypassed CSRF.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/request',
        'post' => ['csrf' => $csrf, 'server' => '1063', 'message' => '<script>request</script>']]);
    expect($result['status'] === 303, 'Permission request failed.');
    $access = json_decode(file_get_contents($private . DIRECTORY_SEPARATOR . 'access.json'), true);
    $requestId = $access['requests'][0]['id'];
    $seed($users[0]['id']);
    $result = $request(['session' => $session, 'query' => ['view' => 'admin']]);
    expect(str_contains($result['html'], '&lt;script&gt;request&lt;/script&gt;'), 'Request message was not escaped.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/admin/decision',
        'post' => ['csrf' => $csrf, 'request' => $requestId, 'status' => 'approved', 'message' => 'Welcome']]);
    expect($result['status'] === 303, 'Approval failed.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/admin/roles',
        'post' => ['csrf' => $csrf, 'target' => $users[1]['id'], 'server' => '999', 'editor' => '1']]);
    expect($result['status'] === 303, 'Additional server grant failed.');
    $seed($users[1]['id']);
    $result = $request(['session' => $session, 'route' => '/session']);
    $userSession = json_decode($result['html'], true);
    expect($userSession['user']['editable_servers'] === ['S1063', 'S999']
        && $userSession['unread_count'] === 2, 'Scoped session or notifications failed.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/read',
        'post' => ['csrf' => $csrf, 'through' => '3']]);
    expect($result['status'] === 303, 'Notification read failed.');
    $result = $request(['session' => $session, 'route' => '/session']);
    expect(json_decode($result['html'], true)['unread_count'] === 0, 'Read notification count not cleared.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/maps/S1047',
        'query' => ['server' => 'S1047'], 'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 0, 'map' => $map])]]);
    expect($result['status'] === 403, 'Approved user saved to unrelated server.');
    $result = $request(['session' => $session, 'route' => '/maps']);
    expect($result['status'] === 403, 'Editor received all-server catalog.');
    $result = $request(['session' => $session, 'route' => '/maps/S1063', 'query' => ['server' => 'S1063']]);
    expect($result['status'] === 200 && json_decode($result['html'], true)['code'] === $code,
        'Editor could not bootstrap sharing link.');
    $newSave = ['session' => $session, 'method' => 'POST', 'route' => '/maps/S999',
        'query' => ['server' => 'S999'],
        'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 0, 'map' => $map])]];
    $result = $request(['session' => $session, 'route' => '/maps/S999',
        'query' => ['server' => 'S999']]);
    expect($result['status'] === 200 && json_decode($result['html'], true)['revision'] === 0,
        'Editor could not open unregistered empty map.');
    $result = $request($newSave);
    $newCode = json_decode($result['html'], true)['code'];
    expect($result['status'] === 200 && $newCode !== $code, 'New server registration failed.');
    $result = $request(['route' => '/maps/S999', 'query' => ['map' => $code]]);
    expect($result['status'] === 403, 'Code reused across servers.');
    $result = $request(['route' => '/maps/S999', 'query' => ['map' => $newCode]]);
    expect($result['status'] === 200 && json_decode($result['html'], true)['revision'] === 1,
        'New server shared read failed.');
    $seed($users[0]['id']);
    $result = $request(['session' => $session, 'route' => '/maps']);
    expect(json_decode($result['html'], true)['servers'] === ['S999', 'S1063'], 'New server missing from admin catalog.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/admin/roles',
        'post' => ['csrf' => $csrf, 'target' => $users[1]['id'], 'server' => '1063']]);
    expect($result['status'] === 303, 'Permission revocation failed.');
    $seed($users[1]['id']);
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/maps/S1063/restore',
        'query' => $query, 'post' => ['csrf' => $csrf, 'payload' => json_encode(['base_revision' => 2, 'restore_revision' => 1])]]);
    expect($result['status'] === 403, 'Stale session retained revoked restore permission.');
    $seed($users[0]['id']);
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/admin/suspension',
        'post' => ['csrf' => $csrf, 'target' => $users[1]['id'], 'stop' => '1']]);
    expect($result['status'] === 303, 'Admin suspension failed.');
    $seed($users[1]['id']);
    $result = $request(['session' => $session]);
    expect(str_contains($result['html'], '編集停止中')
        && !str_contains($result['html'], '編集停止の管理'), 'Suspension not reflected.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/name',
        'post' => ['csrf' => $csrf, 'name' => 'Same Name']]);
    expect($result['status'] === 303, 'Duplicate display name rejected.');
    $result = $request(['session' => $session]);
    expect(str_contains($result['html'], '編集停止中'), 'Rename cleared suspension.');
    $save['post']['payload'] = json_encode(['base_revision' => 2, 'map' => $map]);
    $save['query'] = $query;
    $result = $request($save);
    expect($result['status'] === 403, 'Suspension did not block API save.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/admin/suspension',
        'post' => ['csrf' => $csrf, 'target' => $users[1]['id'], 'stop' => '0']]);
    expect($result['status'] === 400, 'Non-admin removed suspension.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/account/name',
        'post' => ['csrf' => 'invalid', 'name' => 'Other']]);
    expect($result['status'] === 403, 'Name update bypassed CSRF.');
    $latestUsers = json_decode(file_get_contents($private . DIRECTORY_SEPARATOR . 'users.json'), true, 32, JSON_THROW_ON_ERROR);
    for ($index = 1; $index <= 25; $index++) {
        $latestUsers[] = ['sub' => (string) (1000 + $index),
            'id' => 'user-' . str_pad(dechex(1000 + $index), 24, '0', STR_PAD_LEFT),
            'display_name' => 'Pagination ' . $index, 'admin' => false, 'suspended' => false,
            'registered_at' => null];
    }
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'users.json',
        json_encode($latestUsers, JSON_THROW_ON_ERROR)) !== false, 'Pagination fixture failed.');
    $seed($users[0]['id']);
    $result = $request(['session' => $session, 'query' => ['view' => 'admin', 'tab' => 'users']]);
    expect(substr_count($result['html'], '<article>') === 20 && str_contains($result['html'], '次へ'),
        'User list did not paginate.');
    expect(substr_count($result['html'], '<details name="user-detail">') === 20
        && str_contains($result['html'], '<details class="filter-options">')
        && strpos($result['html'], '>ログアウト</button>') < strpos($result['html'], '<main '),
        'Administration did not collapse detail or expose logout.');
    $result = $request(['session' => $session, 'query' => ['view' => 'admin', 'tab' => 'users', 'page' => '2']]);
    expect(substr_count($result['html'], '<article>') === 7, 'User list second page failed.');
    $result = $request(['session' => $session, 'query' => ['view' => 'admin', 'tab' => 'users', 'q' => 'Pagination 25']]);
    expect(substr_count($result['html'], '<article>') === 1, 'User search did not filter.');
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/auth/logout',
        'post' => ['csrf' => $csrf]]);
    expect($result['status'] === 303 && $result['state'] === [], 'Logout failed.');
    echo "Login, privacy, CSRF, profiles, suspension, scoped sharing, server registration, saves, conflicts, history and restore: OK\n";
} finally {
    // Only explicitly named fixture files and PHP-generated session files are removed.
    $sessions = $private . DIRECTORY_SEPARATOR . 'sessions-v2';
    if (is_dir($sessions)) {
        foreach (new DirectoryIterator($sessions) as $file) {
            if ($file->isFile() && preg_match('/^sess_[A-Za-z0-9,-]+$/D', $file->getFilename())) {
                expect(unlink($file->getPathname()), 'Session cleanup failed.');
            }
        }
        expect(rmdir($sessions), 'Session directory cleanup failed.');
    }
    foreach (['config.php', 'google-client.json', 'users.json', 'users.lock', 'access.json'] as $name) {
        $file = $private . DIRECTORY_SEPARATOR . $name;
        if (file_exists($file)) {
            expect(unlink($file), 'Config cleanup failed.');
        }
        foreach (['S1063', 'S1047', 'S999'] as $server) {
            $directory = $private . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . $server;
            if (is_dir($directory)) {
                foreach (new DirectoryIterator($directory) as $file) {
                    if ($file->isFile() && preg_match('/^(head\.json|save\.lock|share\.json|share-code\.json|share\.lock|revision-[a-f0-9]{32}\.json)$/D', $file->getFilename())) {
                        expect(unlink($file->getPathname()), 'Map cleanup failed.');
                    }
                }
                expect(rmdir($directory), 'Map directory cleanup failed.');
            }
        }
        if (is_dir($private . DIRECTORY_SEPARATOR . 'maps')) {
            expect(rmdir($private . DIRECTORY_SEPARATOR . 'maps'), 'Maps cleanup failed.');
        }
        if (file_exists($private . DIRECTORY_SEPARATOR . 'maps.lock')) {
            expect(unlink($private . DIRECTORY_SEPARATOR . 'maps.lock'), 'Maps lock cleanup failed.');
        }
    }
    expect(rmdir($private), 'Private directory cleanup failed.');
    expect(rmdir($root . DIRECTORY_SEPARATOR . 'www'), 'Document root cleanup failed.');
    expect(rmdir($root), 'Fixture cleanup failed.');
}
