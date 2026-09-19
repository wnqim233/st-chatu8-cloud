import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePrivateBackup } from '../wavespeed/migration.js';
import { createWaveSpeedAdapter } from '../wavespeed/adapter.js';
import { DEFAULT_CONFIG } from '../shared/config.js';
const backup = () => ({version:2,kind:'st-chatu8-cloud-private-settings',config:structuredClone(DEFAULT_CONFIG),credentials:{civitaiKey:'test-private-key'}});

test('private migration restores keys without copying jobs or identity; ordinary import ignores injected keys', async () => {
  let written;
  const adapter=createWaveSpeedAdapter({api:async(path,body)=>{assert.equal(path,'/config');written=body;return body;}});
  const data=backup();data.config.civitaiKey='ignored-config-key';data.credentials.cloudStorageId='foreign-id';data.jobs=[{status:'queued'}];
  await adapter.importConfig(data);
  assert.equal(written.civitaiKey,'test-private-key');assert.equal(written.cloudStorageId,undefined);assert.equal(written.jobs,undefined);
  await adapter.importConfig({version:1,config:{civitaiKey:'ignored-key',civitaiMaxBuzz:81}});
  assert.equal(written.civitaiKey,undefined);assert.equal(written.civitaiMaxBuzz,81);
});

test('private migration validates keys and parameters and refuses worldbook/vocabulary payloads', () => {
  let data=backup();data.worlds=[{name:'sample',data:{entries:{}}}];assert.throws(()=>validatePrivateBackup(data),/世界书/);
  data=backup();data.resources=[{database:'chatu8_cloud_gallery',store:'tags',records:[]}];assert.throws(()=>validatePrivateBackup(data),/词库/);
  data=backup();data.credentials.civitaiKey={};assert.throws(()=>validatePrivateBackup(data),/Key/);
  data=backup();data.config.civitaiParams={steps:-1};assert.throws(()=>validatePrivateBackup(data),/steps/);
});
