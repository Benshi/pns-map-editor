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
    'sub' => '123456', 'name' => 'Survivor'];
$sign = static function (array $payload, array $header = ['alg' => 'RS256', 'kid' => 'fixture']) use ($privateKey): string {
    $input = encodeUrl(json_encode($header, JSON_THROW_ON_ERROR)) . '.'
        . encodeUrl(json_encode($payload, JSON_THROW_ON_ERROR));
    expect(openssl_sign($input, $signature, $privateKey, OPENSSL_ALGO_SHA256), 'Signing failed.');
    return $input . '.' . encodeUrl($signature);
};
$verify = static fn(string $token): array => verifyGoogleToken($token, [$key], 'test-client', 'test-nonce', $now);
$identity = $verify($sign($claims));
expect($identity === ['sub' => '123456', 'name' => 'Survivor'], 'Identity mismatch.');
$withEmail = $claims + ['email' => 'private@example.com', 'email_verified' => true];
expect($verify($sign($withEmail)) === $identity, 'Unrequested email was retained.');
foreach ([
    ['aud', 'wrong-client'], ['iss', 'https://attacker.example'],
    ['exp', $now], ['iat', $now + 120], ['nonce', 'wrong-nonce'],
    ['sub', '../user'], ['name', ['invalid']],
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
    $path = $directory . DIRECTORY_SEPARATOR . 'users.json';
    $legacy = [
        ['sub' => '123456', 'email' => 'private@example.com', 'servers' => ['S1047' => 'admin']],
        ['sub' => '234567', 'email' => 'other@example.com', 'servers' => []],
    ];
    expect(file_put_contents($path, json_encode($legacy, JSON_THROW_ON_ERROR)) !== false, 'Legacy fixture failed.');
    $admin = registerIdentity($directory, $identity);
    expect($admin['registered_at'] === null, 'Invented a registration date for a legacy user.');
    $users = readUsers($path);
    expect($admin['admin'] && $admin['display_name'] === null && !canEdit($admin),
        'Legacy administrator migration failed.');
    expect(!str_contains(file_get_contents($path), 'email')
        && !str_contains(file_get_contents($path), 'example.com'), 'Migration retained email.');
    expect(count($users) === 2 && $users[0]['id'] !== $users[1]['id'], 'IDs are not unique.');
    expect(registerIdentity($directory, $identity)['id'] === $admin['id'], 'ID changed on login.');
    expect(count(readUsers($directory . DIRECTORY_SEPARATOR . 'users.json')) === 2, 'Duplicate identity.');
    $stranger = ['sub' => '345678', 'name' => 'Survivor'];
    $other = registerIdentity($directory, $stranger);
    expect(is_string($other['registered_at'])
        && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $other['registered_at']) === 1,
        'New user registration date was not recorded in UTC.');
    $registeredAt = $other['registered_at'];
    $existing = $other;
    unset($existing['registered_at']);
    expect(normalizeUsers([$existing])[0]['registered_at'] === null,
        'Invented a date for an existing user without the new field.');
    expect(registerIdentity($directory, $stranger)['registered_at'] === $registeredAt,
        'Registration date changed on login.');
    foreach ([123, '', 'yesterday', '2026-02-30T00:00:00Z', '2026-10-14T25:00:00Z'] as $invalidDate) {
        $invalidUsers = readUsers($path);
        $invalidUsers[0]['registered_at'] = $invalidDate;
        rejects(static fn() => normalizeUsers($invalidUsers), 'Invalid registration date was accepted.');
    }
    expect(!$other['admin'] && !canEdit($other), 'New user got administrator/edit access.');
    saveDisplayName($directory, $admin['id'], 'Survivor');
    saveDisplayName($directory, $other['id'], 'Survivor');
    $other = registerIdentity($directory, $stranger);
    expect($other['registered_at'] === $registeredAt, 'Name change removed the registration date.');
    expect(canEdit($other) && $other['display_name'] === 'Survivor', 'Duplicate names were rejected.');
    foreach (['', ' ', "bad\nname", str_repeat('a', 81), "\xff"] as $bad) {
        rejects(static fn() => saveDisplayName($directory, $other['id'], $bad), 'Invalid name accepted.');
    }
    saveDisplayName($directory, $other['id'], '日本語');
    expect(registerIdentity($directory, $stranger)['display_name'] === '日本語', 'Unicode name failed.');
    $config = ['admin_user_id' => null];
    rejects(static fn() => suspendUser($directory, $other['id'], $admin['id'], true, $config),
        'Non-admin suspended another user.');
    rejects(static fn() => suspendUser($directory, $admin['id'], $admin['id'], true, $config),
        'Administrator suspended themselves.');
    suspendUser($directory, $admin['id'], $other['id'], true, $config);
    expect(registerIdentity($directory, $stranger)['registered_at'] === $registeredAt,
        'Suspension removed the registration date.');
    saveDisplayName($directory, $other['id'], 'Renamed');
    expect(!canEdit(registerIdentity($directory, $stranger)), 'Rename/login bypassed suspension.');
    suspendUser($directory, $admin['id'], $other['id'], false, $config);
    expect(canEdit(registerIdentity($directory, $stranger)), 'Suspension lift failed.');
    expect(file_put_contents($directory . DIRECTORY_SEPARATOR . 'users.json', '{broken') !== false,
        'Could not write malformed fixture.');
    rejects(static fn() => registerIdentity($directory, $stranger), 'Ignored corrupt registry.');
    expect(file_get_contents($directory . DIRECTORY_SEPARATOR . 'users.json') === '{broken',
        'Overwrote corrupt registry.');
    echo "Email removal, immutable IDs, duplicate names, validation, suspension and corruption tests: OK\n";
} finally {
    foreach (['users.json', 'users.lock'] as $name) {
        $path = $directory . DIRECTORY_SEPARATOR . $name;
        if (file_exists($path)) {
            expect(unlink($path), 'Fixture cleanup failed.');
        }
    }
    expect(rmdir($directory), 'Fixture directory cleanup failed.');
}
