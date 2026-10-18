<?php
declare(strict_types=1);

require __DIR__ . '/auth.php';
require __DIR__ . '/maps.php';
umask(0077);
set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});

function expect(bool $value, string $message): void
{
    if (!$value) {
        throw new RuntimeException($message);
    }
}
function rejects(callable $operation, string $message): void
{
    try {
        $operation();
    } catch (InvalidArgumentException) {
        return;
    }
    throw new RuntimeException($message);
}

$root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'pns-access-test-' . bin2hex(random_bytes(16));
expect(mkdir($root, 0700), 'Fixture creation failed.');
$adminId = 'user-' . str_repeat('a', 24);
$editorId = 'user-' . str_repeat('b', 24);
$approverId = 'user-' . str_repeat('c', 24);
$users = [];
foreach ([$adminId, $editorId, $approverId] as $index => $id) {
    $users[] = ['sub' => (string) ($index + 1), 'id' => $id, 'display_name' => 'User ' . $index,
        'admin' => false, 'suspended' => false, 'registered_at' => null];
}
$config = ['admin_user_id' => $adminId];
$action = static fn(string $actor, string $action, array $data) => changeAccess($root, $actor, $action, $data, $config);
try {
    file_put_contents($root . DIRECTORY_SEPARATOR . 'users.json', json_encode($users, JSON_THROW_ON_ERROR));
    expect(!canEditServer($users[1], 'S10', $config, readAccess($root)), 'Legacy profile inherited permissions.');
    expect(canEditServer($users[0], 'S10', $config, readAccess($root)), 'Configured administrator lost access.');
    $action($editorId, 'request', ['server' => '10', 'message' => "Guild ABC\nPlease approve"]);
    $access = readAccess($root);
    expect(unreadAccessCount($access, $adminId) === 1, 'Administrator was not notified.');
    $id = $access['requests'][0]['id'];
    rejects(static fn() => $action($editorId, 'request', ['server' => '10', 'message' => 'duplicate']),
        'Duplicate pending application accepted.');
    rejects(static fn() => $action($editorId, 'decision', ['request' => $id, 'status' => 'approved']),
        'Applicant approved own request.');
    rejects(static fn() => $action($adminId, 'decision', ['request' => $id, 'status' => 'held', 'message' => '']),
        'Hold without explanation accepted.');
    $action($adminId, 'decision', ['request' => $id, 'status' => 'held', 'message' => 'Need verification']);
    expect(!canEditServer($users[1], 'S10', $config, readAccess($root)), 'Held request granted edit access.');
    $action($adminId, 'read', ['through' => 1]);
    expect(readAccess($root)['requests'][0]['status'] === 'held', 'Reading notification processed request.');
    $action($adminId, 'decision', ['request' => $id, 'status' => 'approved', 'message' => '']);
    $access = readAccess($root);
    expect(canEditServer($users[1], 'S10', $config, $access), 'Approval did not grant edit access.');
    expect(!canEditServer($users[1], 'S11', $config, $access), 'Approval leaked to another server.');
    expect(unreadAccessCount($access, $editorId) === 2, 'Decisions were not notified.');
    rejects(static fn() => $action($adminId, 'decision', ['request' => $id, 'status' => 'rejected', 'message' => 'late']),
        'Finalized request processed twice.');
    $action($adminId, 'roles', ['target' => $approverId, 'server' => '10', 'approver' => '1']);
    expect(!canEditServer($users[2], 'S10', $config, readAccess($root)), 'Approver implicitly acquired edit access.');
    $action($editorId, 'request', ['server' => '11', 'message' => 'Other server']);
    $id11 = readAccess($root)['requests'][1]['id'];
    rejects(static fn() => $action($approverId, 'decision', ['request' => $id11, 'status' => 'approved']),
        'Approver approved a different server.');
    $action($adminId, 'decision', ['request' => $id11, 'status' => 'rejected', 'message' => 'Not eligible']);
    $action($editorId, 'request', ['server' => '11', 'message' => 'Reapply']);
    expect(count(readAccess($root)['requests']) === 3, 'Reapplication after rejection failed.');
    $action($adminId, 'roles', ['target' => $editorId, 'server' => '10']);
    expect(!canEditServer($users[1], 'S10', $config, readAccess($root)), 'Revocation did not apply.');
    rejects(static fn() => saveSharedMap($root, 'S10', 0, emptySharedMap(), $editorId, null, $config),
        'Revoked user saved with stale session.');
    $action($editorId, 'request', ['server' => '10', 'message' => 'Apply again after revocation']);
    $access = readAccess($root);
    $id10 = $access['requests'][3]['id'];
    expect(unreadAccessCount($access, $approverId) >= 2, 'Delegated approver did not receive request notification.');
    $action($approverId, 'decision', ['request' => $id10, 'status' => 'approved', 'message' => '']);
    expect(canEditServer($users[1], 'S10', $config, readAccess($root)), 'Delegated approval failed.');
    $beforeRejectedRoles = readAccess($root);
    rejects(static fn() => $action($approverId, 'roles',
        ['target' => $approverId, 'server' => '10', 'editor' => '1']),
        'Approver changed their own roles.');
    rejects(static fn() => $action($approverId, 'roles',
        ['target' => $editorId, 'server' => '10', 'approver' => '1']),
        'Approver delegated approval authority.');
    rejects(static fn() => $action($adminId, 'roles',
        ['target' => $editorId, 'server' => '10', 'editor' => 'yes']),
        'Malformed role value silently revoked access.');
    expect(readAccess($root) === $beforeRejectedRoles, 'Rejected role change modified registry.');
    $action($editorId, 'read', ['through' => count(readAccess($root)['notifications'])]);
    expect(unreadAccessCount(readAccess($root), $editorId) === 0, 'Read cursor failed.');
    $action($adminId, 'roles', ['target' => $editorId, 'server' => '10', 'editor' => '1']);
    expect(unreadAccessCount(readAccess($root), $editorId) === 1, 'New notification was lost after read.');
    suspendUser($root, $adminId, $approverId, true, $config);
    rejects(static fn() => $action($approverId, 'roles', ['target' => $editorId, 'server' => '10']),
        'Suspended approver changed roles.');
    rejects(static fn() => $action($editorId, 'request', ['server' => '../secret', 'message' => 'bad']),
        'Invalid server accepted.');
    rejects(static fn() => $action($editorId, 'request', ['server' => '12', 'message' => str_repeat('a', 1001)]),
        'Oversized message accepted.');
    expect(count(readAccess($root)['requests']) === 4, 'Rejected operation modified access registry.');
    echo "Server permissions, migration, approval, hold, rejection, delegation, revocation and notifications: OK\n";
} finally {
    $directory = $root . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . 'S10';
    if (is_dir($directory)) {
        rmdir($directory);
        rmdir($root . DIRECTORY_SEPARATOR . 'maps');
    }
    foreach (['users.json', 'users.lock', 'access.json', 'maps.lock'] as $name) {
        $path = $root . DIRECTORY_SEPARATOR . $name;
        if (file_exists($path)) {
            unlink($path);
        }
    }
    rmdir($root);
}
