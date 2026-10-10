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
        $_COOKIE['pns_map_session'] = $request['session'];
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
        'admin_email' => 'admin@example.com', 'admin_servers' => ['S1047']];
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'config.php',
        '<?php return ' . var_export($config, true) . ';') !== false, 'Config fixture failed.');
    expect(file_put_contents($private . DIRECTORY_SEPARATOR . 'google-client.json', json_encode([
        'web' => ['client_id' => 'test-client', 'client_secret' => 'fixture-secret',
            'redirect_uris' => [$config['redirect_uri']]],
    ], JSON_THROW_ON_ERROR)) !== false, 'OAuth fixture failed.');
    $result = $request([]);
    expect($result['status'] === 200 && str_contains($result['html'], 'Google でログイン'),
        'Login page failed.');
    expect(!str_contains($result['html'], 'fixture-secret'), 'Secret leaked.');
    $session = $result['session'];
    $csrf = $result['state']['csrf'];
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
    $result = $request(['session' => $session, 'method' => 'POST', 'route' => '/auth/logout',
        'post' => ['csrf' => $csrf]]);
    expect($result['status'] === 303 && $result['state'] === [], 'Logout failed.');
    echo "HTTPS, missing config, login, CSRF, PKCE, callback state, cancellation, replay and logout: OK\n";
} finally {
    // Only explicitly named fixture files and PHP-generated session files are removed.
    $sessions = $private . DIRECTORY_SEPARATOR . 'sessions';
    if (is_dir($sessions)) {
        foreach (new DirectoryIterator($sessions) as $file) {
            if ($file->isFile() && preg_match('/^sess_[A-Za-z0-9,-]+$/D', $file->getFilename())) {
                expect(unlink($file->getPathname()), 'Session cleanup failed.');
            }
        }
        expect(rmdir($sessions), 'Session directory cleanup failed.');
    }
    foreach (['config.php', 'google-client.json'] as $name) {
        $file = $private . DIRECTORY_SEPARATOR . $name;
        if (file_exists($file)) {
            expect(unlink($file), 'Config cleanup failed.');
        }
    }
    expect(rmdir($private), 'Private directory cleanup failed.');
    expect(rmdir($root . DIRECTORY_SEPARATOR . 'www'), 'Document root cleanup failed.');
    expect(rmdir($root), 'Fixture cleanup failed.');
}
