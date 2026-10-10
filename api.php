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
    $sessionDirectory = $private . DIRECTORY_SEPARATOR . 'sessions';
    if (!is_dir($sessionDirectory) && !mkdir($sessionDirectory, 0700)) {
        throw new RuntimeException('Could not create private session directory.');
    }
    $sessionLifetime = 7 * 24 * 3600;
    session_name('pns_map_session');
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
            'response_type' => 'code', 'scope' => 'openid email',
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
        registerIdentity($private, $identity, $config);
        if (!session_regenerate_id(true)) {
            throw new RuntimeException('Session rotation failed.');
        }
        $_SESSION['identity'] = $identity;
        $_SESSION['expires'] = time() + $sessionLifetime;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        redirect($config['base_url']);
    }
    if ($route !== '' && $route !== '/') {
        page('ページがありません', '<p>指定された操作には対応していません。</p>', 404);
    }
    if ($method !== 'GET') {
        header('Allow: GET');
        page('操作に対応していません', '<p>GET で開いてください。</p>', 405);
    }
    $identity = $_SESSION['identity'] ?? null;
    $csrf = escape($_SESSION['csrf']);
    if ($identity === null) {
        page('P&S マップへのログイン', '<p>Google のパスワードは、このサイトには送信されません。</p>'
            . '<form method="post" action="' . escape($config['base_url'] . '/auth/login') . '">'
            . '<input type="hidden" name="csrf" value="' . $csrf . '">'
            . '<button>Google でログイン</button></form>');
    }
    $permissions = [];
    foreach (readUsers($private . '/users.json') as $user) {
        if ($user['sub'] === $identity['sub']) {
            $permissions = $user['servers'];
            break;
        }
    }
    $content = '<p>ログイン中：' . escape($identity['email']) . '</p>';
    if (!$permissions) {
        $content .= '<p>閲覧・編集できるサーバーがありません。管理者による権限設定が必要です。</p>';
    } else {
        $content .= '<ul>';
        $labels = ['viewer' => '閲覧者', 'editor' => '編集者', 'admin' => '管理者'];
        foreach ($permissions as $server => $role) {
            $content .= '<li>' . escape((string) $server) . '：' . escape($labels[$role]) . '</li>';
        }
        $content .= '</ul>';
    }
    $content .= '<p>今回はログインと権限の確認のみです。マップの共有保存はまだ未実装です。</p>'
        . '<form method="post" action="' . escape($config['base_url'] . '/auth/logout') . '">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '"><button>ログアウト</button></form>';
    page('ログイン確認', $content);
} catch (Throwable $error) {
    $reference = bin2hex(random_bytes(6));
    error_log('pns auth [' . $reference . ']: ' . $error->getMessage());
    page('ログイン処理を完了できません', '<p>設定または通信を確認してください。秘密情報は共有せず、'
        . '管理者に次の番号をお知らせください。</p><p>確認番号：' . escape($reference) . '</p>', 500);
}
