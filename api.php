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
require __DIR__ . '/server/account.php';

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
        . '<style>:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:64rem;margin:0 auto;padding:1rem;line-height:1.7;background:#14251d;color:#edf2e9}'
        . 'a{color:#a8dfff}h1{font-size:1.5rem}h2{font-size:1.2rem;color:#d5e9ad}h3{font-size:1.05rem}p{overflow-wrap:anywhere}'
        . 'section,article,.notice{padding:1rem;margin:1rem 0;border:1px solid #526b57;border-radius:.6rem;background:#1c3226}section{scroll-margin-top:8rem}'
        . 'article{background:#243d2e}nav{display:flex;align-items:center;flex-wrap:wrap;gap:.7rem;margin:.7rem 0}'
        . '.account-nav{position:sticky;top:0;z-index:1;background:#14251df5;padding:.6rem 0;border-bottom:1px solid #526b57}'
        . 'label{display:grid;gap:.3rem;margin:.6rem 0}input,textarea,select,button{font:inherit;border:1px solid #819977;border-radius:.3rem;padding:.6rem;background:#14251d;color:inherit;max-width:100%}'
        . 'input,textarea,select{width:100%}textarea{resize:vertical}button,.primary{background:#385744;cursor:pointer}button{margin:.3rem 0}'
        . '.primary{padding:.5rem .8rem;border-radius:.3rem;color:#fff;text-decoration:none}.badge{display:inline-block;padding:0 .4rem;background:#385744;border-radius:.3rem}'
        . '.message{white-space:pre-wrap;border-left:3px solid #819977;padding-left:.7rem}.check{display:inline-flex;align-items:center;margin-right:1rem}.check input{width:auto}'
        . '.filters{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end}.filters label{flex:1 1 10rem}.danger{border-color:#df9990}summary{cursor:pointer;padding:.5rem}'
        . 'body:has(.account-shell){height:100dvh;display:flex;flex-direction:column;overflow:hidden;padding:.6rem 1rem}'
        . 'body:has(.account-shell)>h1{font-size:1.1rem;margin:0;flex:none}.account-shell{display:flex;flex-direction:column;min-height:0;flex:1}'
        . '.account-nav{position:static;flex:none;margin:.2rem 0;padding:.2rem 0;gap:.5rem}.account-nav form{margin-left:auto}.account-nav button{padding:.35rem .6rem}'
        . '.account-identity{margin:.25rem 0;font-size:.9rem;flex:none}.account-tabs{display:flex;flex-wrap:nowrap;gap:.35rem;flex:none;margin:.3rem 0}'
        . '.account-tabs a{flex:1;text-align:center;text-decoration:none;padding:.4rem .2rem;border:1px solid #526b57;border-radius:.3rem;font-size:.9rem}'
        . '[aria-current="page"]{background:#385744;color:#fff;font-weight:bold}.account-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:.1rem .2rem .5rem}'
        . '.account-content section{margin:.4rem 0;padding:.6rem}.account-content h2{margin:.2rem 0}.account-content p{margin:.4rem 0}.account-content article{margin:.4rem 0;padding:.2rem .4rem}'
        . '.account-content .admin-tabs{position:sticky;top:0;background:#14251d;z-index:1}.filter-options{border-bottom:1px solid #526b57}.account-content .notice{margin:.4rem 0;padding:.5rem}'
        . '.account-content label{line-height:1.4;margin:.45rem 0;gap:.2rem}.account-content input,.account-content textarea,.account-content select{padding:.45rem}'
        . ':focus-visible{outline:3px solid #a8dfff;outline-offset:2px}@media(max-width:600px){body{padding:.7rem}.account-nav{font-size:.9rem}section,article{padding:.7rem}button{min-height:44px}}</style>'
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
    $access = readAccess($private);
        if ($route === '/session' || $route === '/maps' || str_starts_with($route, '/maps/')) {
            try {
                $admin = $currentUser !== null && !$currentUser['suspended'] && isAdmin($currentUser, $config);
                if ($route === '/session' && $method === 'GET') {
                    $permissions = $currentUser === null ? [] : ($access['permissions'][$currentUser['id']] ?? []);
                    $editableServers = $currentUser !== null && canEdit($currentUser)
                        ? array_keys(array_filter($permissions, static fn(array $roles): bool => $roles['editor'])) : [];
                    jsonResponse(['user' => $currentUser === null ? null : [
                        'id' => $currentUser['id'], 'display_name' => $currentUser['display_name'],
                        'can_edit' => canEdit($currentUser) && ($admin || $editableServers !== []),
                        'editable_servers' => $editableServers,
                        'admin' => $admin, 'suspended' => $currentUser['suspended'],
                    ], 'unread_count' => $currentUser === null ? 0 : unreadAccessCount($access, $currentUser['id']),
                        'csrf' => $_SESSION['csrf']]);
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
                if ($route === '/maps' && $method === 'GET' && $admin) {
                    jsonResponse(['servers' => $servers, 'server' => $requested]);
                }
                if (!$admin && (!is_string($requested) || !preg_match('/^S[0-9]{1,10}$/D', $requested))) {
                    jsonResponse(['error' => '閲覧には共有URL、編集には対象サーバーの承認が必要です。'], 403);
                }
                if ($route === '/maps' && $method === 'GET') {
                    $match = [null, $requested];
                } elseif (!preg_match('~^/maps/(S[0-9]{1,10})(?:/(history|restore|revisions/([0-9]+)))?$~D',
                    $route, $match)) {
                    jsonResponse(['error' => 'サーバーが見つかりません。'], 404);
                }
                $server = $match[1];
                $editor = canEditServer($currentUser, $server, $config, $access);
                if (!$admin && $server !== $requested) {
                    jsonResponse(['error' => '指定サーバー以外は閲覧できません。'], 403);
                }
                $registered = in_array($server, $servers, true);
                $directory = $private . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . $server;
                $code = $registered ? mapShareCode(($admin || $editor) ? mapDirectory($private, $server) : $directory,
                    $admin || $editor) : null;
                if (!$admin && !$editor && (!$registered || $code === null
                    || !is_string($provided) || !hash_equals($code, $provided))) {
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
                    if (!$editor) {
                        jsonResponse(['error' => '編集にはGoogleログイン・表示名登録と対象サーバーの承認が必要です。編集停止中は保存できません。'], 403);
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
                        $operation === 'restore' ? $input['restore_revision'] : null, $config);
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
    if (in_array($route, ['/account/request', '/admin/decision', '/admin/roles', '/account/read'], true)) {
        if ($method !== 'POST') {
            header('Allow: POST');
            page('操作に対応していません', '<p>画面のボタンから操作してください。</p>', 405);
        }
        if ($currentUser === null || !is_string($_POST['csrf'] ?? null)
            || !hash_equals($_SESSION['csrf'], $_POST['csrf'])) {
            page('操作を確認できません', '<p>ログイン画面を開き直してください。</p>', 403);
        }
        try {
            $action = ['/account/request' => 'request', '/admin/decision' => 'decision',
                '/admin/roles' => 'roles', '/account/read' => 'read'][$route];
            changeAccess($private, $currentUser['id'], $action, $_POST, $config);
            $_SESSION['account_notice'] = '操作を保存しました。';
        } catch (InvalidArgumentException $error) {
            page('操作を保存できません', '<p>' . escape($error->getMessage()) . '</p><p><a href="'
                . escape($config['base_url']) . '">利用者設定に戻る</a></p>', 400);
        }
        $destination = match ($route) {
            '/admin/roles' => '?view=admin&tab=users',
            '/admin/decision' => '?view=admin',
            '/account/read' => '?tab=notifications',
            default => '?tab=requests',
        };
        redirect($config['base_url'] . $destination);
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
        redirect($config['base_url'] . ($route === '/admin/suspension' ? '?view=admin&tab=users' : '?tab=profile'));
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
            page('戻り先を確認できません', '<p>マップの「ログイン」または「アカウント」から開き直してください。</p>', 400);
        }
        $_SESSION['map_return_query'] = $query;
    }
    $mapQuery = $_SESSION['map_return_query'] ?? '';
    $mapReturn = dirname($config['base_url']) . '/index.html'
        . ($mapQuery === '' ? '' : '?' . $mapQuery);
    renderAccount($private, $config, $currentUser, $users, $access, $mapReturn);
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
