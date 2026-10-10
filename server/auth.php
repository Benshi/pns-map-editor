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
        || !is_string($claims['sub'] ?? null) || !preg_match('/^[0-9]{1,255}$/D', $claims['sub'])
        || ($claims['email_verified'] ?? null) !== true
        || !is_string($claims['email'] ?? null)
        || filter_var($claims['email'], FILTER_VALIDATE_EMAIL) === false) {
        throw new RuntimeException('ID token claims verification failed.');
    }
    return ['sub' => $claims['sub'], 'email' => $claims['email']];
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
        || !str_ends_with($url['path'] ?? '', '/api.php/auth/callback')
        || !is_string($config['admin_email'] ?? null)
        || filter_var($config['admin_email'], FILTER_VALIDATE_EMAIL) === false
        || !is_array($config['admin_servers'] ?? null) || !$config['admin_servers']) {
        throw new RuntimeException('Invalid configuration.');
    }
    foreach ($config['admin_servers'] as $server) {
        if (!is_string($server) || !preg_match('/^S[0-9]{1,10}$/D', $server)) {
            throw new RuntimeException('Invalid server identifier.');
        }
    }
    $oauth = json_decode(file_get_contents($private . DIRECTORY_SEPARATOR . 'google-client.json'),
        true, 32, JSON_THROW_ON_ERROR);
    $web = $oauth['web'] ?? null;
    if (!is_array($web) || !is_string($web['client_id'] ?? null) || $web['client_id'] === ''
        || !is_string($web['client_secret'] ?? null) || $web['client_secret'] === ''
        || !in_array($config['redirect_uri'], $web['redirect_uris'] ?? [], true)) {
        throw new RuntimeException('Invalid OAuth client configuration.');
    }
    $config['client_id'] = $web['client_id'];
    $config['client_secret'] = $web['client_secret'];
    $config['base_url'] = substr($config['redirect_uri'], 0, -strlen('/auth/callback'));
    return $config;
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
    foreach ($users as $user) {
        if (!is_array($user) || !is_string($user['sub'] ?? null)
            || !is_string($user['email'] ?? null) || !is_array($user['servers'] ?? null)) {
            throw new RuntimeException('Invalid users registry.');
        }
        foreach ($user['servers'] as $server => $role) {
            if (!preg_match('/^S[0-9]{1,10}$/D', (string) $server)
                || !in_array($role, ['viewer', 'editor', 'admin'], true)) {
                throw new RuntimeException('Invalid user permission.');
            }
        }
    }
    return $users;
}

function registerIdentity(string $private, array $identity, array $config): void
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
        $users = readUsers($path);
        foreach ($users as $user) {
            if ($user['sub'] === $identity['sub']) {
                return;
            }
        }
        $servers = [];
        if (strcasecmp($identity['email'], $config['admin_email']) === 0) {
            foreach ($users as $user) {
                if (strcasecmp($user['email'], $config['admin_email']) === 0) {
                    throw new RuntimeException('Administrator identity has already been bound.');
                }
            }
            $servers = array_fill_keys($config['admin_servers'], 'admin');
        }
        $users[] = $identity + ['servers' => $servers];
        $json = json_encode($users, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $temporary = $private . DIRECTORY_SEPARATOR . 'users-' . bin2hex(random_bytes(16)) . '.tmp';
        if (file_put_contents($temporary, $json) !== strlen($json) || !rename($temporary, $path)) {
            throw new RuntimeException('Could not persist users registry.');
        }
        $temporary = null;
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
