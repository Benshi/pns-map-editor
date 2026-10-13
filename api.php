<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
umask(0077);
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});
require __DIR__ . '/server/auth.php';
require __DIR__ . '/server/maps.php';

function jsonResponse(array $body, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit;
}

function escape(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function page(string $title, string $content, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: text/html; charset=UTF-8');
    echo '<!doctype html><html lang="ja"><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . escape($title) . '</title>'
        . '<style>body{font-family:sans-serif;max-width:45rem;margin:2rem auto;padding:0 1rem;line-height:1.8}'
        . 'button{font:inherit;padding:.6rem}li{margin:.5rem 0}</style>'
        . '<h1>' . escape($title) . '</h1>' . $content . '</html>';
    exit;
}

function redirect(string $url): never
{
    header('Location: ' . $url, true, 303);
    exit;
}

try {
    if (($_SERVER['HTTPS'] ?? '') === '' || $_SERVER['HTTPS'] === 'off') {
        page('HTTPS が必要です', '<p>HTTPS の URL で開いてください。</p>', 400);
    }
    $root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    $private = realpath(getenv('PNS_MAP_PRIVATE_DIR')
        ?: ($root === false ? '' : dirname($root) . '/pns-map-private'));
    if ($root === false || $private === false || !is_dir($private)
        || $private === $root || str_starts_with($private, $root . DIRECTORY_SEPARATOR)) {
        throw new RuntimeException('Private directory must exist outside the document root.');
    }
    $config = loadAuthConfig($private);
    updateUsers($private, static fn(array $users): array => $users);
    $sessionDirectory = $private . DIRECTORY_SEPARATOR . 'sessions-v2';
    if (!is_dir($sessionDirectory) && !mkdir($sessionDirectory, 0700)) {
        throw new RuntimeException('Could not create private session directory.');
    }
    $sessionLifetime = 7 * 24 * 3600;
    session_name('pns_map_session_v2');
    if (!session_start([
        'use_strict_mode' => 1, 'use_only_cookies' => 1,
        'cookie_secure' => true, 'cookie_httponly' => true,
        'cookie_samesite' => 'Lax',
        'cookie_path' => dirname(parse_url($config['base_url'], PHP_URL_PATH)) . '/',
        'cookie_lifetime' => $sessionLifetime,
        'save_path' => $sessionDirectory,
        'gc_maxlifetime' => $sessionLifetime,
    ])) {
        throw new RuntimeException('Session initialization failed.');
    }
    if (!isset($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    $now = time();
    if (isset($_SESSION['expires']) && $_SESSION['expires'] <= $now) {
        unset($_SESSION['identity'], $_SESSION['expires']);
    }
    $route = $_SERVER['PATH_INFO'] ?? '';
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if (($route === '/auth/login' || $route === '/auth/logout') && $method === 'POST') {
        if (!is_string($_POST['csrf'] ?? null) || !hash_equals($_SESSION['csrf'], $_POST['csrf'])) {
            page('操作を確認できません', '<p>ログイン画面を開き直してください。</p>', 403);
        }
        if ($route === '/auth/logout') {
            $_SESSION = [];
            $cookie = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => $now - 3600, 'path' => $cookie['path'],
                'secure' => true, 'httponly' => true, 'samesite' => 'Lax',
            ]);
            if (!session_destroy()) {
                throw new RuntimeException('Session destruction failed.');
            }
            redirect($config['base_url']);
        }
        $_SESSION['oauth'] = [
            'state' => bin2hex(random_bytes(32)),
            'nonce' => bin2hex(random_bytes(32)),
            'verifier' => bin2hex(random_bytes(32)),
            'created' => $now,
        ];
        $pending = $_SESSION['oauth'];
        redirect('https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query([
            'client_id' => $config['client_id'], 'redirect_uri' => $config['redirect_uri'],
            'response_type' => 'code', 'scope' => 'openid profile',
            'state' => $pending['state'], 'nonce' => $pending['nonce'],
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $pending['verifier'], true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256', 'prompt' => 'select_account',
        ]));
    }
    if ($route === '/auth/callback' && $method === 'GET') {
        $pending = $_SESSION['oauth'] ?? null;
        unset($_SESSION['oauth']);
        if (!is_array($pending) || $pending['created'] + 600 < $now
            || !is_string($_GET['state'] ?? null) || !hash_equals($pending['state'], $_GET['state'])) {
            page('ログインを確認できません', '<p>ログイン画面からやり直してください。</p>', 403);
        }
        if (isset($_GET['error'])) {
            page('ログインが完了しませんでした', '<p>Google ログインがキャンセルまたは拒否されました。戻ってやり直してください。</p>');
        }
        if (!is_string($_GET['code'] ?? null) || strlen($_GET['code']) > 4096) {
            page('ログインを確認できません', '<p>認証コードが不正です。ログインをやり直してください。</p>', 400);
        }
        $response = googleRequest('https://oauth2.googleapis.com/token', [
            'client_id' => $config['client_id'], 'client_secret' => $config['client_secret'],
            'code' => $_GET['code'], 'code_verifier' => $pending['verifier'],
            'grant_type' => 'authorization_code', 'redirect_uri' => $config['redirect_uri'],
        ]);
        $jwks = googleRequest('https://www.googleapis.com/oauth2/v3/certs');
        if (!is_string($response['id_token'] ?? null) || !is_array($jwks['keys'] ?? null)) {
            throw new RuntimeException('Google response did not contain identity information.');
        }
        $identity = verifyGoogleToken($response['id_token'], $jwks['keys'],
            $config['client_id'], $pending['nonce'], time());
        $user = registerIdentity($private, $identity);
        if (!session_regenerate_id(true)) {
            throw new RuntimeException('Session rotation failed.');
        }
        $_SESSION['identity'] = $user['id'];
        if ($user['display_name'] === null) {
            $_SESSION['suggested_name'] = $identity['name'];
        }
        $_SESSION['expires'] = time() + $sessionLifetime;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        redirect($config['base_url']);
    }
    $users = readUsers($private . '/users.json');
    $currentUser = null;
    foreach ($users as $user) {
        if ($user['id'] === ($_SESSION['identity'] ?? null)) {
            $currentUser = $user;
            break;
        }
    }
        if ($route === '/session' || $route === '/maps' || str_starts_with($route, '/maps/')) {
            try {
                $admin = $currentUser !== null && isAdmin($currentUser, $config);
                $editor = $currentUser !== null && canEdit($currentUser);
                if ($route === '/session' && $method === 'GET') {
                    jsonResponse(['user' => $currentUser === null ? null : [
                        'id' => $currentUser['id'], 'display_name' => $currentUser['display_name'],
                        'can_edit' => canEdit($currentUser), 'admin' => $admin, 'suspended' => $currentUser['suspended'],
                    ], 'csrf' => $_SESSION['csrf']]);
                }
                $servers = registeredMapServers($private, $config['servers']);
                $requested = $_GET['server'] ?? null;
                $provided = $_GET['map'] ?? null;
                if ($provided !== null) {
                    if (!is_string($provided)
                        || ($resolved = sharedCodeServer($private, $servers, $provided)) === null) {
                        jsonResponse(['error' => '共有コードが無効です。共有URLを確認してください。'], 403);
                    }
                    if ($requested !== null && $requested !== $resolved) {
                        jsonResponse(['error' => '指定サーバー以外は閲覧できません。'], 403);
                    }
                    $requested = $resolved;
                }
                if (!$admin && !$editor && $provided === null) {
                    jsonResponse(['error' => '閲覧にはmapを含む共有URLが必要です。'], 403);
                }
                if ($route === '/maps' && $method === 'GET' && $admin) {
                    jsonResponse(['servers' => $servers, 'server' => $requested]);
                }
                if (!$admin && (!is_string($requested) || !preg_match('/^S[0-9]{1,10}$/D', $requested))) {
                    jsonResponse(['error' => 'サーバー番号を指定してください。'], 400);
                }
                if ($route === '/maps' && $method === 'GET') {
                    $match = [null, $requested];
                } elseif (!preg_match('~^/maps/(S[0-9]{1,10})(?:/(history|restore|revisions/([0-9]+)))?$~D',
                    $route, $match)) {
                    jsonResponse(['error' => 'サーバーが見つかりません。'], 404);
                }
                $server = $match[1];
                if (!$admin && $server !== $requested) {
                    jsonResponse(['error' => '指定サーバー以外は閲覧できません。'], 403);
                }
                $registered = in_array($server, $servers, true);
                $directory = $private . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . $server;
                $code = $registered ? mapShareCode(($admin || $editor) ? mapDirectory($private, $server) : $directory,
                    $admin || $editor) : null;
                if (!$admin && !$editor && (!$registered || $code === null || !hash_equals($code, $provided))) {
                    jsonResponse(['error' => '共有コードが無効です。共有URLを確認してください。'], 403);
                }
                if ($route === '/maps' && $method === 'GET') {
                    jsonResponse(['servers' => [$server], 'server' => $server]);
                }
                $operation = $match[2] ?? '';
                if ($method === 'GET') {
                    if ($operation === '') {
                        jsonResponse(publicRevision($registered ? currentMap($directory) : emptyMapRevision()) + ['code' => $code]);
                    }
                    if (str_starts_with($operation, 'revisions/')) {
                        if (!$registered) {
                            throw new InvalidArgumentException('指定された版が見つかりません。');
                        }
                        jsonResponse(publicRevision(findMapRevision($directory, (int) $match[3])));
                    }
                    if ($operation === 'history') {
                        $revision = $registered ? currentMap($directory) : emptyMapRevision();
                        $history = [];
                        while ($revision['revision'] > 0 && count($history) < 100) {
                            $history[] = publicRevision($revision, false);
                            if ($revision['parent'] === null) {
                                break;
                            }
                            $revision = readMapRevision($directory, $revision['parent']);
                        }
                        jsonResponse(['history' => $history]);
                    }
                }
                if ($method === 'POST' && ($operation === '' || $operation === 'restore')) {
                    if ($currentUser === null || !canEdit($currentUser)) {
                        jsonResponse(['error' => '編集するにはログインと表示名登録が必要です。編集停止中は保存できません。'], 403);
                    }
                    if (!is_string($_POST['csrf'] ?? null) || !hash_equals($_SESSION['csrf'], $_POST['csrf'])) {
                        jsonResponse(['error' => 'ログイン状態を確認できません。ページを開き直してください。'], 403);
                    }
                    $payload = $_POST['payload'] ?? null;
                    if (!is_string($payload) || strlen($payload) > 5 * 1024 * 1024) {
                        jsonResponse(['error' => '保存データは5MB以下のJSONで送信してください。'], 413);
                    }
                    try {
                        $input = json_decode($payload, true, 64, JSON_THROW_ON_ERROR);
                    } catch (JsonException) {
                        jsonResponse(['error' => 'JSONの形式が不正です。'], 400);
                    }
                    if (!is_array($input) || !is_int($input['base_revision'] ?? null)
                        || $input['base_revision'] < 0
                        || ($operation === 'restore' && (!is_int($input['restore_revision'] ?? null)
                            || $input['restore_revision'] < 1))) {
                        throw new InvalidArgumentException('版番号が不正です。');
                    }
                    $saved = saveSharedMap($private, $server, $input['base_revision'],
                        $input['map'] ?? null, $currentUser['id'],
                        $operation === 'restore' ? $input['restore_revision'] : null);
                    jsonResponse($saved + ['code' => mapShareCode(mapDirectory($private, $server), true)]);
                }
                header('Allow: GET, POST');
                jsonResponse(['error' => '対応していない操作です。'], 405);
            } catch (MapConflict $error) {
                jsonResponse(['error' => $error->getMessage()], 409);
            } catch (InvalidArgumentException $error) {
                jsonResponse(['error' => $error->getMessage()], 400);
            }
        }
    if ($route === '/account/name' || $route === '/admin/suspension') {
        if ($method !== 'POST') {
            header('Allow: POST');
            page('操作に対応していません', '<p>画面のボタンから操作してください。</p>', 405);
        }
        if ($currentUser === null || !is_string($_POST['csrf'] ?? null)
            || !hash_equals($_SESSION['csrf'], $_POST['csrf'])) {
            page('操作を確認できません', '<p>ログイン画面を開き直してください。</p>', 403);
        }
        try {
            if ($route === '/account/name') {
                if (!is_string($_POST['name'] ?? null)) {
                    throw new InvalidArgumentException('表示名を入力してください。');
                }
                saveDisplayName($private, $currentUser['id'], $_POST['name']);
                unset($_SESSION['suggested_name']);
            } else {
                if (!is_string($_POST['target'] ?? null)
                    || !in_array($_POST['stop'] ?? null, ['0', '1'], true)) {
                    throw new InvalidArgumentException('対象と操作を指定してください。');
                }
                suspendUser($private, $currentUser['id'], $_POST['target'], $_POST['stop'] === '1', $config);
            }
        } catch (InvalidArgumentException $error) {
            page('変更を保存できません', '<p>' . escape($error->getMessage())
                . '</p><p><a href="' . escape($config['base_url']) . '">設定画面へ戻る</a></p>', 400);
        }
        redirect($config['base_url']);
    }
    if ($route !== '' && $route !== '/') {
        page('ページがありません', '<p>指定された操作には対応していません。</p>', 404);
    }
    if ($method !== 'GET') {
        header('Allow: GET');
        page('操作に対応していません', '<p>GET で開いてください。</p>', 405);
    }
    if (array_key_exists('return', $_GET)) {
        $query = $_GET['return'];
        if (!is_string($query) || strlen($query) > 2048 || preg_match('/[\x00-\x1f\x7f#]/', $query)) {
            page('戻り先を確認できません', '<p>マップのログイン・利用者設定から開き直してください。</p>', 400);
        }
        $_SESSION['map_return_query'] = $query;
    }
    $mapQuery = $_SESSION['map_return_query'] ?? '';
    $mapReturn = dirname($config['base_url']) . '/index.html'
        . ($mapQuery === '' ? '' : '?' . $mapQuery);
    $backLink = '<p><a href="' . escape($mapReturn) . '">マップに戻る</a></p>';
    $csrf = escape($_SESSION['csrf']);
    if ($currentUser === null) {
        page('P&S マップへのログイン', '<p>閲覧はログイン不要、編集はログインと表示名の登録が必要です。'
            . 'Google のメールアドレスは要求・保存しません。</p>'
            . '<form method="post" action="' . escape($config['base_url'] . '/auth/login') . '">'
            . '<input type="hidden" name="csrf" value="' . $csrf . '">'
            . '<button>Google でログイン</button></form>' . $backLink);
    }
    $content = '<p>識別名：' . escape($currentUser['id']) . '（変更できません）</p>';
    if ($currentUser['suspended']) {
        $content .= '<p>編集停止中です。表示名変更や再ログインでは解除されません。</p>';
    } elseif (canEdit($currentUser)) {
        $content .= '<p>編集者として登録済みです。</p>';
    } else {
        $content .= '<p>表示名を登録するまでは閲覧のみです。</p>';
    }
    $name = $currentUser['display_name'] ?? ($_SESSION['suggested_name'] ?? '');
    $content .= '<form method="post" action="' . escape($config['base_url'] . '/account/name') . '">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<label>公開する表示名 <input name="name" maxlength="80" required value="' . escape($name) . '"></label>'
        . '<p>同名は使用可能です。Google の名前を使いたくない場合は変更してください。'
        . '確定した表示名は編集履歴に公開されます。</p><button>表示名を保存</button></form>';
    if (isAdmin($currentUser, $config) && !$currentUser['suspended']) {
        $content .= '<h2>管理者：編集停止の管理</h2>';
        $content .= '<ul>';
        foreach ($users as $user) {
            $content .= '<li>' . escape($user['display_name'] ?? '表示名未登録') . ' · '
                . escape($user['id']);
            $content .= '<br>登録日時：' . ($user['registered_at'] === null ? ''
                : escape((new DateTimeImmutable($user['registered_at']))
                    ->setTimezone(new DateTimeZone('Asia/Tokyo'))->format('Y-m-d H:i:s')) . '（日本時間）');
            if (isAdmin($user, $config)) {
                $content .= '（管理者）';
            } else {
                $content .= $user['suspended'] ? '（編集停止中）' : '（編集停止なし）';
                $content .= '<form method="post" action="' . escape($config['base_url'] . '/admin/suspension') . '">'
                    . '<input type="hidden" name="csrf" value="' . $csrf . '">'
                    . '<input type="hidden" name="target" value="' . escape($user['id']) . '">'
                    . '<input type="hidden" name="stop" value="' . ($user['suspended'] ? '0' : '1') . '">'
                    . '<button>' . ($user['suspended'] ? '編集停止を解除' : '編集を停止') . '</button></form>';
            }
            $content .= '</li>';
        }
        $content .= '</ul>';
    }
    $content .= $backLink
        . '<form method="post" action="' . escape($config['base_url'] . '/auth/logout') . '">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '"><button>ログアウト</button></form>';
    page('ログイン確認', $content);
} catch (Throwable $error) {
    $reference = bin2hex(random_bytes(6));
    error_log('pns auth [' . $reference . ']: ' . $error->getMessage());
    if (str_starts_with($_SERVER['PATH_INFO'] ?? '', '/maps')
        || ($_SERVER['PATH_INFO'] ?? '') === '/session') {
        jsonResponse(['error' => 'サーバー処理に失敗しました。確認番号：' . $reference], 500);
    }
    page('ログイン処理を完了できません', '<p>設定または通信を確認してください。秘密情報は共有せず、'
        . '管理者に次の番号をお知らせください。</p><p>確認番号：' . escape($reference) . '</p>', 500);
}
