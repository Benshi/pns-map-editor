<?php
declare(strict_types=1);

function base64urlDecode(string $value): string
{
    if (!preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
        throw new RuntimeException('Invalid token encoding.');
    }
    $decoded = base64_decode(strtr($value, '-_', '+/'), true);
    if ($decoded === false) {
        throw new RuntimeException('Invalid token encoding.');
    }
    return $decoded;
}

function asn1(string $tag, string $value): string
{
    $length = strlen($value);
    $encoded = '';
    if ($length < 128) {
        $encoded = chr($length);
    } else {
        while ($length > 0) {
            $encoded = chr($length & 255) . $encoded;
            $length >>= 8;
        }
        $encoded = chr(128 | strlen($encoded)) . $encoded;
    }
    return $tag . $encoded . $value;
}

function googlePublicKey(array $key): string
{
    if (($key['kty'] ?? null) !== 'RSA' || !is_string($key['n'] ?? null)
        || !is_string($key['e'] ?? null)) {
        throw new RuntimeException('Invalid signing key.');
    }
    $integer = static function (string $value): string {
        $bytes = ltrim(base64urlDecode($value), "\0");
        if ($bytes === '') {
            throw new RuntimeException('Invalid RSA integer.');
        }
        if (ord($bytes[0]) >= 128) {
            $bytes = "\0" . $bytes;
        }
        return asn1("\x02", $bytes);
    };
    $rsa = asn1("\x30", $integer($key['n']) . $integer($key['e']));
    $algorithm = hex2bin('300d06092a864886f70d0101010500');
    $der = asn1("\x30", $algorithm . asn1("\x03", "\0" . $rsa));
    return "-----BEGIN PUBLIC KEY-----\n"
        . chunk_split(base64_encode($der), 64, "\n")
        . "-----END PUBLIC KEY-----\n";
}

function verifyGoogleToken(string $token, array $keys, string $clientId, string $nonce, int $now): array
{
    $parts = explode('.', $token);
    if (count($parts) !== 3 || strlen($token) > 16384) {
        throw new RuntimeException('Invalid ID token.');
    }
    $header = json_decode(base64urlDecode($parts[0]), true, 16, JSON_THROW_ON_ERROR);
    $claims = json_decode(base64urlDecode($parts[1]), true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($header) || !is_array($claims)
        || ($header['alg'] ?? null) !== 'RS256' || !is_string($header['kid'] ?? null)) {
        throw new RuntimeException('Invalid ID token header.');
    }
    $signingKey = null;
    foreach ($keys as $key) {
        if (is_array($key) && ($key['kid'] ?? null) === $header['kid']) {
            $signingKey = $key;
            break;
        }
    }
    if ($signingKey === null || openssl_verify(
        $parts[0] . '.' . $parts[1],
        base64urlDecode($parts[2]),
        googlePublicKey($signingKey),
        OPENSSL_ALGO_SHA256
    ) !== 1) {
        throw new RuntimeException('ID token signature verification failed.');
    }
    if (!in_array($claims['iss'] ?? null, ['https://accounts.google.com', 'accounts.google.com'], true)
        || ($claims['aud'] ?? null) !== $clientId
        || (isset($claims['azp']) && $claims['azp'] !== $clientId)
        || !is_int($claims['exp'] ?? null) || $claims['exp'] <= $now
        || !is_int($claims['iat'] ?? null) || $claims['iat'] > $now + 60
        || !is_string($claims['nonce'] ?? null) || !hash_equals($nonce, $claims['nonce'])
        || !is_string($claims['sub'] ?? null) || !preg_match('/^[0-9]{1,255}$/D', $claims['sub'])) {
        throw new RuntimeException('ID token claims verification failed.');
    }
    $name = $claims['name'] ?? '';
    if (!is_string($name) || preg_match('//u', $name) !== 1) {
        throw new RuntimeException('Invalid profile name.');
    }
    return ['sub' => $claims['sub'], 'name' => $name];
}

function googleRequest(string $url, ?array $form = null): array
{
    $curl = curl_init($url);
    if ($curl === false) {
        throw new RuntimeException('Could not initialize HTTPS request.');
    }
    $body = '';
    try {
        curl_setopt_array($curl, [
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body): int {
                if (strlen($body) + strlen($chunk) > 262144) {
                    return 0;
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        if ($form !== null) {
            curl_setopt($curl, CURLOPT_POST, true);
            curl_setopt($curl, CURLOPT_POSTFIELDS, http_build_query($form));
            curl_setopt($curl, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);
        }
        if (curl_exec($curl) === false || curl_getinfo($curl, CURLINFO_HTTP_CODE) !== 200) {
            throw new RuntimeException('Google HTTPS request failed.');
        }
        $result = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($result)) {
            throw new RuntimeException('Invalid Google response.');
        }
        return $result;
    } finally {
        curl_close($curl);
    }
}

function loadAuthConfig(string $private): array
{
    $config = require $private . DIRECTORY_SEPARATOR . 'config.php';
    if (!is_array($config) || !is_string($config['redirect_uri'] ?? null)) {
        throw new RuntimeException('Invalid configuration.');
    }
    $url = parse_url($config['redirect_uri']);
    if ($url === false || ($url['scheme'] ?? '') !== 'https'
        || empty($url['host']) || isset($url['user']) || isset($url['pass'])
        || isset($url['query']) || isset($url['fragment'])
        || !str_ends_with($url['path'] ?? '', '/api.php/auth/callback')) {
        throw new RuntimeException('Invalid configuration.');
    }
    $adminId = $config['admin_user_id'] ?? null;
    if ($adminId !== null && (!is_string($adminId)
        || !preg_match('/^user-[a-f0-9]{24}$/D', $adminId))) {
        throw new RuntimeException('Invalid administrator identifier.');
    }
    $oauth = json_decode(file_get_contents($private . DIRECTORY_SEPARATOR . 'google-client.json'),
        true, 32, JSON_THROW_ON_ERROR);
    $web = $oauth['web'] ?? null;
    if (!is_array($web) || !is_string($web['client_id'] ?? null) || $web['client_id'] === ''
        || !is_string($web['client_secret'] ?? null) || $web['client_secret'] === ''
        || !in_array($config['redirect_uri'], $web['redirect_uris'] ?? [], true)) {
        throw new RuntimeException('Invalid OAuth client configuration.');
    }
    // Ignore legacy email settings; only the necessary settings enter runtime state.
    $servers = $config['servers'] ?? ['S1063'];
    if (!is_array($servers) || !array_is_list($servers) || !$servers || count($servers) > 2000
        || count(array_unique($servers, SORT_REGULAR)) !== count($servers)) {
        throw new RuntimeException('Invalid server list.');
    }
    foreach ($servers as $server) {
        if (!is_string($server) || !preg_match('/^S[0-9]{1,10}$/D', $server)) {
            throw new RuntimeException('Invalid server identifier.');
        }
    }
    $config = ['redirect_uri' => $config['redirect_uri'], 'admin_user_id' => $adminId, 'servers' => $servers];
    $config['client_id'] = $web['client_id'];
    $config['client_secret'] = $web['client_secret'];
    $config['base_url'] = substr($config['redirect_uri'], 0, -strlen('/auth/callback'));
    return $config;
}

function normalizeUsers(array $users): array
{
    if (!array_is_list($users)) {
        throw new RuntimeException('Invalid users registry.');
    }
    $subjects = [];
    $ids = [];
    $result = [];
    foreach ($users as $user) {
        if (!is_array($user) || !is_string($user['sub'] ?? null)
            || !preg_match('/^[0-9]{1,255}$/D', $user['sub'])
            || isset($subjects[$user['sub']])) {
            throw new RuntimeException('Invalid users registry.');
        }
        $subjects[$user['sub']] = true;
        if (!isset($user['id'])) {
            if (!is_string($user['email'] ?? null) || !is_array($user['servers'] ?? null)) {
                throw new RuntimeException('Invalid legacy users registry.');
            }
            foreach ($user['servers'] as $server => $role) {
                if (!preg_match('/^S[0-9]{1,10}$/D', (string) $server)
                    || !in_array($role, ['viewer', 'editor', 'admin'], true)) {
                    throw new RuntimeException('Invalid legacy permission.');
                }
            }
            $user = ['sub' => $user['sub'], 'id' => newUserId($ids),
                'display_name' => null, 'admin' => in_array('admin', $user['servers'], true),
                'suspended' => false];
        }
        if (!is_string($user['id']) || !preg_match('/^user-[a-f0-9]{24}$/D', $user['id'])
            || isset($ids[$user['id']]) || !array_key_exists('display_name', $user)
            || ($user['display_name'] !== null && (!is_string($user['display_name'])
                || displayName($user['display_name']) !== $user['display_name']))
            || !is_bool($user['admin'] ?? null) || !is_bool($user['suspended'] ?? null)
            || (isset($user['registered_at']) && (!is_string($user['registered_at'])
                || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $user['registered_at'])
                || (DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $user['registered_at'],
                    new DateTimeZone('UTC')) ?: null)?->format('Y-m-d\TH:i:s\Z') !== $user['registered_at']))) {
            throw new RuntimeException('Invalid users registry.');
        }
        $ids[$user['id']] = true;
        $result[] = ['sub' => $user['sub'], 'id' => $user['id'],
            'display_name' => $user['display_name'], 'admin' => $user['admin'],
            'suspended' => $user['suspended'], 'registered_at' => $user['registered_at'] ?? null];
    }
    return $result;
}

function newUserId(array $existing): string
{
    do {
        $id = 'user-' . bin2hex(random_bytes(12));
    } while (isset($existing[$id]));
    return $id;
}

function displayName(string $name): string
{
    $name = trim($name);
    if (preg_match('//u', $name) !== 1 || preg_match('/[\p{C}]/u', $name)
        || preg_match_all('/./us', $name) < 1 || preg_match_all('/./us', $name) > 80) {
        throw new InvalidArgumentException('表示名は制御文字を含まない1〜80文字にしてください。');
    }
    return $name;
}

function readUsers(string $path): array
{
    if (!file_exists($path)) {
        return [];
    }
    $users = json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($users)) {
        throw new RuntimeException('Invalid users registry.');
    }
    $normalized = normalizeUsers($users);
    if ($normalized !== $users) {
        throw new RuntimeException('Users registry needs migration.');
    }
    return $users;
}

function updateUsers(string $private, callable $change): array
{
    $lock = fopen($private . DIRECTORY_SEPARATOR . 'users.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException('Could not open users lock.');
    }
    $temporary = null;
    try {
        if (!flock($lock, LOCK_EX)) {
            throw new RuntimeException('Could not lock users registry.');
        }
        $path = $private . DIRECTORY_SEPARATOR . 'users.json';
        $original = file_exists($path)
            ? json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR) : [];
        if (!is_array($original)) {
            throw new RuntimeException('Invalid users registry.');
        }
        $users = normalizeUsers($change(normalizeUsers($original)));
        if ($users === $original) {
            return $users;
        }
        $json = json_encode($users, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $temporary = $private . DIRECTORY_SEPARATOR . 'users-' . bin2hex(random_bytes(16)) . '.tmp';
        if (file_put_contents($temporary, $json) !== strlen($json) || !rename($temporary, $path)) {
            throw new RuntimeException('Could not persist users registry.');
        }
        $temporary = null;
        return $users;
    } finally {
        try {
            if ($temporary !== null && file_exists($temporary) && !unlink($temporary)) {
                throw new RuntimeException('Could not remove temporary users file.');
            }
        } finally {
            fclose($lock);
        }
    }

}

function registerIdentity(string $private, array $identity): array
{
    $users = updateUsers($private, static function (array $users) use ($identity): array {
        foreach ($users as $user) {
            if ($user['sub'] === $identity['sub']) {
                return $users;
            }
        }
        $ids = array_fill_keys(array_column($users, 'id'), true);
        $users[] = ['sub' => $identity['sub'], 'id' => newUserId($ids),
            'display_name' => null, 'admin' => false, 'suspended' => false,
            'registered_at' => gmdate('Y-m-d\TH:i:s\Z')];
        return $users;
    });
    foreach ($users as $user) {
        if ($user['sub'] === $identity['sub']) {
            return $user;
        }
    }
    throw new RuntimeException('Identity registration failed.');
}

function isAdmin(array $user, array $config): bool
{
    return $user['admin'] || $user['id'] === ($config['admin_user_id'] ?? null);
}

function canEdit(array $user): bool
{
    return $user['display_name'] !== null && !$user['suspended'];
}

function saveDisplayName(string $private, string $id, string $name): void
{
    $clean = displayName($name);
    updateUsers($private, static function (array $users) use ($id, $clean): array {
        foreach ($users as &$user) {
            if ($user['id'] === $id) {
                $user['display_name'] = $clean;
                return $users;
            }
        }
        throw new RuntimeException('User not found.');
    });
}

function suspendUser(string $private, string $actorId, string $targetId, bool $stop, array $config): void
{
    updateUsers($private, static function (array $users) use ($actorId, $targetId, $stop, $config): array {
        $actor = null;
        foreach ($users as $user) {
            if ($user['id'] === $actorId) {
                $actor = $user;
            }
        }
        if ($actor === null || !isAdmin($actor, $config) || $actor['suspended']) {
            throw new InvalidArgumentException('管理者権限が必要です。');
        }
        foreach ($users as &$user) {
            if ($user['id'] === $targetId) {
                if ($stop && isAdmin($user, $config)) {
                    throw new InvalidArgumentException('管理者の編集停止はこの画面では行えません。');
                }
                $user['suspended'] = $stop;
                return $users;
            }
        }
        throw new InvalidArgumentException('対象の利用者が見つかりません。');
    });
}
