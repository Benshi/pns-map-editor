<?php
declare(strict_types=1);

require __DIR__ . '/auth.php';
umask(0077);
set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});

function expect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function rejects(callable $operation, string $message): void
{
    try {
        $operation();
    } catch (Throwable) {
        return;
    }
    throw new RuntimeException($message);
}

function encodeUrl(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

$privateKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
expect($privateKey !== false, 'Could not generate fixture key.');
$details = openssl_pkey_get_details($privateKey);
$key = ['kty' => 'RSA', 'kid' => 'fixture',
    'n' => encodeUrl($details['rsa']['n']), 'e' => encodeUrl($details['rsa']['e'])];
$now = time();
$claims = ['iss' => 'https://accounts.google.com', 'aud' => 'test-client',
    'exp' => $now + 600, 'iat' => $now, 'nonce' => 'test-nonce',
    'sub' => '123456', 'email' => 'admin@example.com', 'email_verified' => true];
$sign = static function (array $payload, array $header = ['alg' => 'RS256', 'kid' => 'fixture']) use ($privateKey): string {
    $input = encodeUrl(json_encode($header, JSON_THROW_ON_ERROR)) . '.'
        . encodeUrl(json_encode($payload, JSON_THROW_ON_ERROR));
    expect(openssl_sign($input, $signature, $privateKey, OPENSSL_ALGO_SHA256), 'Signing failed.');
    return $input . '.' . encodeUrl($signature);
};
$verify = static fn(string $token): array => verifyGoogleToken($token, [$key], 'test-client', 'test-nonce', $now);
$identity = $verify($sign($claims));
expect($identity === ['sub' => '123456', 'email' => 'admin@example.com'], 'Identity mismatch.');
foreach ([
    ['aud', 'wrong-client'], ['iss', 'https://attacker.example'],
    ['exp', $now], ['iat', $now + 120], ['nonce', 'wrong-nonce'],
    ['sub', '../user'], ['email_verified', false], ['email', '<script>'],
    ['azp', 'wrong-client'],
] as [$field, $value]) {
    $changed = $claims;
    $changed[$field] = $value;
    rejects(static fn() => $verify($sign($changed)), 'Accepted invalid claim: ' . $field);
}
rejects(static fn() => $verify($sign($claims, ['alg' => 'none', 'kid' => 'fixture'])), 'Accepted wrong algorithm.');
rejects(static fn() => $verify($sign($claims, ['alg' => 'RS256', 'kid' => 'unknown'])), 'Accepted unknown key.');
$parts = explode('.', $sign($claims));
$changed = $claims;
$changed['sub'] = '999';
$parts[1] = encodeUrl(json_encode($changed, JSON_THROW_ON_ERROR));
rejects(static fn() => $verify(implode('.', $parts)), 'Accepted altered signature.');
rejects(static fn() => $verify('invalid'), 'Accepted malformed token.');
echo "Signature, identity, audience, issuer, expiration, nonce and malformed-token tests: OK\n";

$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'pns-auth-test-' . bin2hex(random_bytes(16));
expect(mkdir($directory, 0700), 'Could not create fixture directory.');
try {
    $config = ['admin_email' => 'admin@example.com', 'admin_servers' => ['S1053', 'S1047', 'S1067']];
    registerIdentity($directory, $identity, $config);
    $users = readUsers($directory . DIRECTORY_SEPARATOR . 'users.json');
    expect(count($users) === 1 && $users[0]['servers'] === [
        'S1053' => 'admin', 'S1047' => 'admin', 'S1067' => 'admin',
    ], 'Administrator bootstrap failed.');
    registerIdentity($directory, $identity, $config);
    expect(count(readUsers($directory . DIRECTORY_SEPARATOR . 'users.json')) === 1, 'Duplicate identity.');
    $stranger = ['sub' => '234567', 'email' => 'stranger@example.com'];
    registerIdentity($directory, $stranger, $config);
    $users = readUsers($directory . DIRECTORY_SEPARATOR . 'users.json');
    expect(count($users) === 2 && $users[1]['servers'] === [], 'Stranger received permissions.');
    rejects(static fn() => registerIdentity($directory,
        ['sub' => '345678', 'email' => 'admin@example.com'], $config), 'Rebound administrator.');
    $users[0]['servers'] = [];
    expect(file_put_contents($directory . DIRECTORY_SEPARATOR . 'users.json',
        json_encode($users, JSON_THROW_ON_ERROR)) !== false, 'Could not update fixture.');
    registerIdentity($directory, $identity, $config);
    expect(readUsers($directory . DIRECTORY_SEPARATOR . 'users.json')[0]['servers'] === [],
        'Revoked permission was restored on login.');
    expect(file_put_contents($directory . DIRECTORY_SEPARATOR . 'users.json', '{broken') !== false,
        'Could not write malformed fixture.');
    rejects(static fn() => registerIdentity($directory, $stranger, $config), 'Ignored corrupt registry.');
    expect(file_get_contents($directory . DIRECTORY_SEPARATOR . 'users.json') === '{broken',
        'Overwrote corrupt registry.');
    echo "Administrator bootstrap, deny-by-default, identity binding, revocation and corruption tests: OK\n";
} finally {
    foreach (['users.json', 'users.lock'] as $name) {
        $path = $directory . DIRECTORY_SEPARATOR . $name;
        if (file_exists($path)) {
            expect(unlink($path), 'Fixture cleanup failed.');
        }
    }
    expect(rmdir($directory), 'Fixture directory cleanup failed.');
}
