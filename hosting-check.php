<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");

set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});

function escape(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

$results = [];
function check(string $label, callable $test): void
{
    global $results;
    try {
        $test();
        $results[] = [$label, true];
    } catch (Throwable $error) {
        // Details stay in the hosting error log, not in the public response.
        error_log('pns hosting check: ' . $label . ': ' . $error->getMessage());
        $results[] = [$label, false];
    }
}

function requireTrue(bool $value): void
{
    if (!$value) {
        throw new RuntimeException('Check did not succeed.');
    }
}

$https = isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'
    && $_SERVER['HTTPS'] !== '';
$sessionReady = false;
check('HTTPS 接続', static function () use ($https): void {
    requireTrue($https);
});
check('PHP 8.3 以上', static function (): void {
    requireTrue(PHP_VERSION_ID >= 80300);
});
check('セッションの開始', static function () use ($https, &$sessionReady): void {
    requireTrue($https);
    session_name('pns_hosting_check');
    requireTrue(session_start([
        'use_strict_mode' => 1,
        'use_only_cookies' => 1,
        'cookie_secure' => true,
        'cookie_httponly' => true,
        'cookie_samesite' => 'Strict',
    ]));
    $sessionReady = true;
    if (!isset($_SESSION['check_token'])) {
        $_SESSION['check_token'] = bin2hex(random_bytes(32));
    }
});

$method = $_SERVER['REQUEST_METHOD'] ?? '';
$run = $method === 'POST' && $sessionReady
    && isset($_POST['token']) && is_string($_POST['token'])
    && hash_equals($_SESSION['check_token'], $_POST['token']);

if ($method === 'POST' && !$run) {
    http_response_code(403);
    $results[] = ['前の画面からのセッション維持（Cookie）', false];
}
if ($run) {
    $results[] = ['前の画面からのセッション維持（Cookie）', true];
    check('安全な乱数生成', static function (): void {
        requireTrue(strlen(random_bytes(32)) === 32);
    });
    check('JSON の保存用エンコード・復元', static function (): void {
        $sample = ['version' => 1, 'name' => 'テスト'];
        $json = json_encode($sample, JSON_THROW_ON_ERROR);
        requireTrue(json_decode($json, true, 512, JSON_THROW_ON_ERROR) === $sample);
    });
    check('外部ログイン用の cURL / OpenSSL 拡張', static function (): void {
        requireTrue(extension_loaded('curl') && extension_loaded('openssl'));
        requireTrue(in_array('https', curl_version()['protocols'], true));
    });

    $directory = null;
    $files = [];
    check('公開領域外の一時ディレクトリ作成', static function () use (&$directory): void {
        $root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
        requireTrue($root !== false && $root !== DIRECTORY_SEPARATOR);
        $parent = realpath(dirname($root));
        requireTrue($parent !== false && $parent !== $root);
        $candidate = $parent . DIRECTORY_SEPARATOR . 'pns-check-' . bin2hex(random_bytes(16));
        requireTrue(mkdir($candidate, 0700));
        $directory = $candidate;
        requireTrue((fileperms($directory) & 0777) === 0700);
    });
    if ($directory !== null) {
        $path = $directory . DIRECTORY_SEPARATOR . 'sample.json';
        $replacement = $directory . DIRECTORY_SEPARATOR . 'replacement.json';
        $files = [$path, $replacement];
        try {
            check('非公開ファイルの書き込み・読み込み', static function () use ($path): void {
                $sample = '{"version":1}';
                $previousMask = umask(0077);
                try {
                    requireTrue(file_put_contents($path, $sample) === strlen($sample));
                } finally {
                    umask($previousMask);
                }
                requireTrue((fileperms($path) & 0777) === 0600);
                requireTrue(file_get_contents($path) === $sample);
            });
            check('flock の排他取得・競合検出・解放', static function () use ($path): void {
                $first = fopen($path, 'r+');
                requireTrue($first !== false);
                $second = null;
                try {
                    $second = fopen($path, 'r+');
                    requireTrue($second !== false);
                    requireTrue(flock($first, LOCK_EX | LOCK_NB));
                    $wouldBlock = 0;
                    requireTrue(!flock($second, LOCK_EX | LOCK_NB, $wouldBlock)
                        && $wouldBlock === 1);
                    requireTrue(flock($first, LOCK_UN));
                    requireTrue(flock($second, LOCK_EX | LOCK_NB));
                    requireTrue(flock($second, LOCK_UN));
                } finally {
                    if (is_resource($second)) {
                        fclose($second);
                    }
                    fclose($first);
                }
            });
            check('同一ディレクトリ内のファイル置き換え', static function () use ($path, $replacement): void {
                $previousMask = umask(0077);
                try {
                    requireTrue(file_put_contents($replacement, '{"version":2}') === 13);
                } finally {
                    umask($previousMask);
                }
                requireTrue(rename($replacement, $path));
                requireTrue(file_get_contents($path) === '{"version":2}');
            });
        } finally {
            check('検証用ファイルとディレクトリの削除', static function () use ($files, $directory): void {
                $removed = true;
                foreach ($files as $file) {
                    try {
                        if (file_exists($file)) {
                            requireTrue(unlink($file));
                        }
                    } catch (Throwable $error) {
                        $removed = false;
                        error_log('pns hosting check cleanup: ' . $error->getMessage());
                    }
                }
                requireTrue(rmdir($directory) && $removed);
            });
        }
    } else {
        $results[] = ['ファイル・flock・置き換え・削除（前提不足のため未実施）', false];
    }
}
$token = $sessionReady ? $_SESSION['check_token'] : '';
if ($sessionReady) {
    check('セッションの書き込み', static function (): void {
        requireTrue(session_write_close());
    });
}
?>
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>P&amp;S ホスティング動作確認</title>
  <style>
    body { font-family: sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.7; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #aaa; padding: .5rem; text-align: left; }
    button { padding: .8rem; font: inherit; }
    .pass { color: #176332; } .fail { color: #a02020; }
  </style>
</head>
<body>
  <h1>ホスティング動作確認</h1>
  <p>検証ページ v1 / PHP <?= escape(PHP_VERSION) ?></p>
  <p>ボタンを押すと、公開領域外に小さな検証用ファイルを作成し、読み書きとロックを確認して削除します。
    既存のマップや設定ファイルには触れません。確認後は、この PHP ファイルをサーバーから削除してください。</p>
  <table>
    <thead><tr><th>確認項目</th><th>結果</th></tr></thead>
    <tbody>
      <?php foreach ($results as [$label, $passed]): ?>
        <tr><td><?= escape($label) ?></td><td class="<?= $passed ? 'pass' : 'fail' ?>"><?= $passed ? 'OK' : '要確認' ?></td></tr>
      <?php endforeach; ?>
    </tbody>
  </table>
  <?php if ($sessionReady && $https): ?>
    <form method="post">
      <input type="hidden" name="token" value="<?= escape($token) ?>">
      <p><button type="submit">ファイル・ロック・セッションを検証する</button></p>
    </form>
  <?php endif; ?>
  <p>cURL / OpenSSL の確認は拡張機能の有無のみです。外部通信・証明書検証はまだ行いません。
    ロックは同じリクエスト内の別ハンドルで検証するため、実運用の同時リクエスト試験は別途必要です。</p>
  <p>「要確認」がある場合は、その項目名をお知らせください。
    内部パスや詳しいエラーは画面に表示せず、サーバーのエラーログに記録します。</p>
</body>
</html>
