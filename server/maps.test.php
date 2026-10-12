<?php
declare(strict_types=1);

require __DIR__ . '/auth.php';
require __DIR__ . '/maps.php';
umask(0077);
set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});

if (getenv('PNS_MAP_TEST_WORKER') === '1') {
    try {
        saveSharedMap(getenv('PNS_MAP_TEST_ROOT'), 'S1063', 3, emptySharedMap(),
            'user-0123456789abcdef01234567');
        echo 'saved';
    } catch (MapConflict) {
        echo 'conflict';
    }
    exit;
}

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
    } catch (InvalidArgumentException | MapConflict) {
        return;
    }
    throw new RuntimeException($message);
}

$root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'pns-map-test-' . bin2hex(random_bytes(16));
expect(mkdir($root, 0700), 'Fixture directory failed.');
$userId = 'user-0123456789abcdef01234567';
$users = [['sub' => '123456', 'id' => $userId, 'display_name' => 'Builder',
    'admin' => false, 'suspended' => false]];
$usersPath = $root . DIRECTORY_SEPARATOR . 'users.json';
expect(file_put_contents($usersPath, json_encode($users, JSON_THROW_ON_ERROR)) !== false, 'Users fixture failed.');
try {
    $map = emptySharedMap();
    $map['guilds'] = [['id' => 'g', 'name' => 'Guild', 'members' => [['id' => 'm', 'name' => 'Member']]]];
    $map['facilities'] = [
        ['id' => 'f', 'type' => 'fortress', 'guildId' => 'g', 'size' => 2, 'x' => 214, 'y' => 452],
        ['id' => 's', 'type' => 'shelter', 'guildId' => 'g', 'memberId' => 'm',
            'size' => 2, 'x' => 220, 'y' => 452],
    ];
    $clean = validateSharedMap($map);
    expect($clean['ownGuildId'] === 'g' && count($clean['facilities']) === 2, 'Valid map rejected.');
    expect(!isset($clean['guilds'][0]['members'][0]['rank']), 'Legacy rank was guessed.');
    $southBoundary = $map;
    $southBoundary['facilities'][0]['x'] = 256;
    $southBoundary['facilities'][0]['y'] = 552;
    rejects(static fn() => validateSharedMap($southBoundary),
        'Facility footprint entered corrected southern wasteland boundary.');
    $wastelandShelter = $map;
    $wastelandShelter['facilities'][1]['x'] = 246;
    $wastelandShelter['facilities'][1]['y'] = 508;
    expect(count(validateSharedMap($wastelandShelter)['facilities']) === 2,
        'Wasteland shelter was rejected.');
    $wastelandFacility = $map;
    $wastelandFacility['facilities'][0]['x'] = 246;
    $wastelandFacility['facilities'][0]['y'] = 508;
    rejects(static fn() => validateSharedMap($wastelandFacility),
        'Non-shelter facility was allowed in wasteland.');
    $wastelandMountain = $map;
    $wastelandMountain['mountains'][] = ['id' => 'wasteland-mountain', 'type' => 'mountain',
        'size' => 2, 'x' => 246, 'y' => 508];
    rejects(static fn() => validateSharedMap($wastelandMountain),
        'Mountain was allowed in wasteland.');
    $labShelter = $map;
    $labShelter['facilities'][1]['x'] = 245;
    $labShelter['facilities'][1]['y'] = 515;
    rejects(static fn() => validateSharedMap($labShelter),
        'Shelter was allowed in the lab boundary.');
    $expanded = $map;
    $expanded['guilds'][0]['members'][0]['rank'] = 4;
    for ($i = 1; $i <= 101; $i++) {
        $expanded['guilds'][0]['members'][] = ['id' => "extra-m$i", 'name' => "Extra$i", 'rank' => 5];
    }
    for ($i = 1; $i <= 5; $i++) {
        $expanded['facilities'][] = ['id' => "o$i", 'type' => "outpost$i", 'guildId' => 'g',
            'size' => 1, 'x' => 220 + $i * 4, 'y' => 450];
    }
    $expandedClean = validateSharedMap($expanded);
    expect(count($expandedClean['facilities']) === 7
        && count($expandedClean['guilds'][0]['members']) === 102
        && $expandedClean['guilds'][0]['members'][0]['rank'] === 4, 'Ranks/outposts did not round-trip.');
    $bad = $expanded;
    $bad['facilities'][2]['type'] = 'outpost6';
    rejects(static fn() => validateSharedMap($bad), 'Accepted nonexistent outpost6.');
    foreach ([0, 6, '4', 4.5, false] as $rank) {
        $bad = $expanded;
        $bad['guilds'][0]['members'][0]['rank'] = $rank;
        rejects(static fn() => validateSharedMap($bad), 'Accepted invalid rank.');
    }
    $bad = $expanded;
    $bad['facilities'][2]['size'] = 2;
    rejects(static fn() => validateSharedMap($bad), 'Accepted 2x2 outpost.');
    $bad = $expanded;
    $bad['facilities'][] = ['id' => 'duplicate', 'type' => 'outpost1', 'guildId' => 'g',
        'size' => 1, 'x' => 280, 'y' => 450];
    rejects(static fn() => validateSharedMap($bad), 'Accepted duplicate numbered outpost.');
    $bad = $expanded;
    $bad['facilities'][2]['x'] = 220;
    $bad['facilities'][2]['y'] = 452;
    rejects(static fn() => validateSharedMap($bad), 'Accepted occupied outpost.');
    foreach ([
        ['x', 0], ['y', 0], ['size', 1], ['type', 'script'], ['guildId', 'missing'],
        ['x', '214'], ['x', 213],
    ] as [$field, $value]) {
        $bad = $map;
        $bad['facilities'][0][$field] = $value;
        rejects(static fn() => validateSharedMap($bad), 'Accepted invalid facility: ' . $field);
    }
    $bad = $map;
    $bad['facilities'][1]['memberId'] = 'missing';
    rejects(static fn() => validateSharedMap($bad), 'Accepted missing member.');
    $bad = $map;
    $bad['mountains'][] = ['id' => 'mountain', 'type' => 'mountain', 'size' => 2, 'x' => 214, 'y' => 452];
    rejects(static fn() => validateSharedMap($bad), 'Accepted occupied mountain.');
    $bad = $map;
    $bad['facilities'][0]['x'] = 256;
    $bad['facilities'][0]['y'] = 512;
    rejects(static fn() => validateSharedMap($bad), 'Accepted forbidden terrain.');
    $directory = mapDirectory($root, 'S1063');
    $expandedSaved = saveSharedMap($root, 'S9999', 0, $expanded, $userId);
    expect($expandedSaved['map'] === $expandedClean
        && currentMap(mapDirectory($root, 'S9999'))['map'] === $expandedClean,
        'Saved ranks/outposts were lost on reload.');
    expect(currentMap($directory)['revision'] === 0, 'New map not empty.');
    $first = saveSharedMap($root, 'S1063', 0, $map, $userId);
    expect($first['revision'] === 1 && $first['map'] === $clean, 'First save failed.');
    expect(!str_contains(json_encode($first, JSON_THROW_ON_ERROR), '"sub"'), 'Public revision leaked sub.');
    rejects(static fn() => saveSharedMap($root, 'S1063', 0, $map, $userId), 'Stale save accepted.');
    $second = saveSharedMap($root, 'S1063', 1, emptySharedMap(), $userId);
    expect($second['revision'] === 2, 'Second save failed.');
    $restored = saveSharedMap($root, 'S1063', 2, null, $userId, 1);
    expect($restored['revision'] === 3 && $restored['restored_from'] === 1
        && $restored['map'] === $clean, 'Restore failed.');
    expect(findMapRevision($directory, 2)['map'] === emptySharedMap(), 'Restore erased history.');
    expect(currentMap(mapDirectory($root, 'S1047'))['revision'] === 0, 'Server isolation failed.');
    $users[0]['suspended'] = true;
    expect(file_put_contents($usersPath, json_encode($users, JSON_THROW_ON_ERROR)) !== false, 'Suspension fixture failed.');
    rejects(static fn() => saveSharedMap($root, 'S1063', 3, $map, $userId), 'Suspended user saved.');
    rejects(static fn() => saveSharedMap($root, 'S1063', 3, null, $userId, 1), 'Suspended user restored.');
    $users[0]['suspended'] = false;
    $users[0]['display_name'] = null;
    expect(file_put_contents($usersPath, json_encode($users, JSON_THROW_ON_ERROR)) !== false, 'Name fixture failed.');
    rejects(static fn() => saveSharedMap($root, 'S1063', 3, $map, $userId), 'Unregistered user saved.');
    $users[0]['display_name'] = 'Renamed';
    expect(file_put_contents($usersPath, json_encode($users, JSON_THROW_ON_ERROR)) !== false, 'Name fixture failed.');
    expect(findMapRevision($directory, 1)['author']['display_name'] === 'Builder', 'Historical name changed.');
    putenv('PNS_MAP_TEST_ROOT=' . $root);
    putenv('PNS_MAP_TEST_WORKER=1');
    $workers = [];
    for ($i = 0; $i < 2; $i++) {
        $process = proc_open([PHP_BINARY, __FILE__], [
            0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w'],
        ], $pipes);
        expect(is_resource($process), 'Worker failed.');
        fclose($pipes[0]);
        $workers[] = [$process, $pipes];
    }
    $outcomes = [];
    foreach ($workers as [$process, $pipes]) {
        $outcomes[] = stream_get_contents($pipes[1]);
        $errors = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        expect(proc_close($process) === 0, 'Concurrent worker failed: ' . $errors);
    }
    sort($outcomes);
    expect($outcomes === ['conflict', 'saved'] && currentMap($directory)['revision'] === 4,
        'Concurrent save did not have exactly one winner.');
    echo "Validation, privacy, server isolation, history, restore, suspension and concurrent saves: OK\n";
} finally {
    foreach (['S1063', 'S1047', 'S9999'] as $server) {
        $directory = $root . DIRECTORY_SEPARATOR . 'maps' . DIRECTORY_SEPARATOR . $server;
        if (is_dir($directory)) {
            foreach (new DirectoryIterator($directory) as $file) {
                if ($file->isFile() && preg_match('/^(head\.json|save\.lock|revision-[a-f0-9]{32}\.json)$/D', $file->getFilename())) {
                    expect(unlink($file->getPathname()), 'Map fixture cleanup failed.');
                }
            }
            expect(rmdir($directory), 'Map directory cleanup failed.');
        }
    }
    $maps = $root . DIRECTORY_SEPARATOR . 'maps';
    if (is_dir($maps)) {
        expect(rmdir($maps), 'Maps directory cleanup failed.');
    }
    foreach (['users.json', 'users.lock', 'maps.lock'] as $name) {
        $path = $root . DIRECTORY_SEPARATOR . $name;
        if (file_exists($path)) {
            expect(unlink($path), 'Fixture cleanup failed.');
        }
    }
    expect(rmdir($root), 'Root fixture cleanup failed.');
}
