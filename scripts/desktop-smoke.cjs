const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

const os = require('node:os');
const assert = require('node:assert/strict');
const executablePath = process.env.SMOKE_EXECUTABLE;
if (!executablePath) throw new Error('Set SMOKE_EXECUTABLE to the packaged Electron executable.');
const suffix = `${process.pid}-${Date.now()}`;
const hostProfile = path.join(os.tmpdir(), `lunch-smoke-host-${suffix}`);
const clientProfile = path.join(os.tmpdir(), `lunch-smoke-client-${suffix}`);

async function launch(profile) {
  return electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], timeout: 30000 });
}

async function addRestaurant(page, name) {
  await page.getByRole('button', { name: '음식점 보관함' }).click();
  await page.locator('#addRestaurantButton').click();
  await page.locator('#restaurantName').fill(name);
  await page.locator('#restaurantAddress').fill('서울 강동구 테스트로 9');
  await page.locator('#formTags').getByRole('button', { name: '한식' }).click();
  await page.getByRole('button', { name: '저장하기' }).click();
}

(async () => {
  const apps = [];
  try {
    const hostApp = await launch(hostProfile); apps.push(hostApp);
    const hostPage = await hostApp.firstWindow();
    const hostErrors = [];
    hostPage.on('pageerror', error => hostErrors.push(error.message));
    await hostPage.waitForFunction(() => document.querySelector('#sideCount')?.textContent === '15');
    await hostPage.getByRole('button', { name: '교육장 공유' }).click();
    await hostPage.locator('#startHostButton').click();
    await hostPage.waitForFunction(() => document.querySelector('#syncStatusTitle')?.textContent === '공유 호스트');
    const code = await hostPage.locator('#hostCode').textContent();
    const hostStatus = await hostPage.locator('#syncStatusTitle').textContent();

    let clientApp = await launch(clientProfile); apps.push(clientApp);
    let clientPage = await clientApp.firstWindow();
    const clientErrors = [];
    clientPage.on('pageerror', error => clientErrors.push(error.message));
    await clientPage.getByRole('button', { name: '교육장 공유' }).click();
    await clientPage.locator('#joinAddress').fill('127.0.0.1');
    await clientPage.locator('#joinCode').fill(code);
    await clientPage.locator('#joinHostButton').click();
    await clientPage.waitForFunction(() => document.querySelector('#syncStatusTitle')?.textContent === '호스트와 연결됨');
    await clientPage.waitForFunction(() => document.querySelector('#sideCount')?.textContent === '15');

    await addRestaurant(hostPage, '호스트가 추가한 식당');
    await hostPage.waitForFunction(() => document.querySelector('#sideCount')?.textContent === '16');
    await clientPage.waitForFunction(() => document.querySelector('#sideCount')?.textContent === '16', null, { timeout: 10000 });
    await addRestaurant(clientPage, '참여 PC가 추가한 식당');
    await clientPage.waitForFunction(() => document.querySelector('#sideCount')?.textContent === '17');
    await hostPage.waitForFunction(() => document.querySelector('#sideCount')?.textContent === '17', null, { timeout: 10000 });

    await clientPage.getByRole('button', { name: '오늘의 추첨' }).click();
    await clientPage.locator('#drawButton').click();
    await clientPage.waitForFunction(() => document.querySelector('#historySideCount')?.textContent === '1');
    await hostPage.waitForFunction(() => document.querySelector('#historySideCount')?.textContent === '1', null, { timeout: 10000 });

    const hostHash = await hostPage.locator('#syncHash').textContent();
    const clientHash = await clientPage.locator('#syncHash').textContent();
    const stored = JSON.parse(await fs.readFile(path.join(hostProfile, 'shared-state.json'), 'utf8'));
    const { canonicalSnapshot } = await import('../app/sync-protocol.mjs');
    const fileHash = createHash('sha256').update(canonicalSnapshot(stored.snapshot)).digest('hex');
    await clientApp.close(); apps.splice(apps.indexOf(clientApp), 1);
    clientApp = await launch(clientProfile); apps.push(clientApp);
    clientPage = await clientApp.firstWindow();
    await clientPage.waitForFunction(() => document.querySelector('#syncStatusTitle')?.textContent === '호스트와 연결됨', null, { timeout: 10000 });
    const autoReconnectedAfterClientRestart = await clientPage.locator('#sideCount').textContent() === '17';
    await hostApp.close(); apps.splice(apps.indexOf(hostApp), 1);
    await clientPage.waitForFunction(() => document.querySelector('#syncStatusTitle')?.textContent === '호스트 연결 대기 중', null, { timeout: 10000 });
    const offlineEditingDisabled = await clientPage.locator('#addRestaurantButton').isDisabled();
    let restartedHost = await launch(hostProfile); apps.push(restartedHost);
    await restartedHost.firstWindow();
    await clientPage.waitForFunction(() => document.querySelector('#syncStatusTitle')?.textContent === '호스트와 연결됨', null, { timeout: 10000 });
    const autoReconnectedAfterHostRestart = await clientPage.locator('#sideCount').textContent() === '17';
    await restartedHost.close(); apps.splice(apps.indexOf(restartedHost), 1);
    const damaged = { ...stored, snapshot: { ...stored.snapshot, restaurants: stored.snapshot.restaurants.slice(1) } };
    await fs.writeFile(path.join(hostProfile, 'shared-state.json'), JSON.stringify(damaged));
    restartedHost = await launch(hostProfile); apps.push(restartedHost);
    const recoveredPage = await restartedHost.firstWindow();
    await recoveredPage.waitForFunction(() => document.querySelector('#syncStatusTitle')?.textContent === '공유 호스트');
    const recovered = JSON.parse(await fs.readFile(path.join(hostProfile, 'shared-state.json'), 'utf8'));
    await clientPage.waitForFunction(expected => document.querySelector('#syncHash')?.textContent === expected,
      recovered.hash.slice(0, 16) + '…', { timeout: 10000 });
    const recoveredHashValid = createHash('sha256').update(canonicalSnapshot(recovered.snapshot)).digest('hex') === recovered.hash;
    assert.equal(fileHash, stored.hash, 'Host file hash must match');
    assert.equal(hostHash, clientHash, 'Both apps must display the same hash');
    assert.equal(stored.snapshot.restaurants.length, 17);
    assert.equal(stored.snapshot.draws.length, 1);
    assert.ok(autoReconnectedAfterClientRestart);
    assert.ok(offlineEditingDisabled);
    assert.ok(autoReconnectedAfterHostRestart);
    assert.ok(recoveredHashValid);
    assert.notEqual(recovered.epoch, stored.epoch);
    assert.deepEqual(hostErrors, []);
    assert.deepEqual(clientErrors, []);
    console.log(JSON.stringify({ hostStatus, clientStatus: await clientPage.locator('#syncStatusTitle').textContent(),
      codeLength: code.length, hostCount: stored.snapshot.restaurants.length,
      clientCount: await clientPage.locator('#sideCount').textContent(),
      drawCount: stored.snapshot.draws.length,
      revision: stored.revision, fileHashValid: fileHash === stored.hash,
      uiHashesMatch: hostHash === clientHash, autoReconnectedAfterClientRestart,
      offlineEditingDisabled, autoReconnectedAfterHostRestart, recoveredHashValid,
      recoveryEpochChanged: recovered.epoch !== stored.epoch, hostErrors, clientErrors }));
  } finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
