/* Private settings migration. Aladdin Free Public License; see ../LICENSE. */
import { DEFAULT_CONFIG, portableConfig, plainObject, updateConfig } from '../shared/config.js';

export function validatePrivateBackup(backup) {
  if (backup?.version !== 2 || backup.kind !== 'st-chatu8-cloud-private-settings') throw new Error('不支持的私密迁移文件版本。');
  const config = portableConfig(backup.config);
  if (!plainObject(backup.credentials)) throw new Error('迁移文件缺少 API 配置。');
  for (const key of ['civitaiKey', 'wavespeedKey']) {
    if (Object.hasOwn(backup.credentials, key)) config[key] = backup.credentials[key];
  }
  // This is a settings-only import. Worldbook files and vocabulary stay on the target device.
  if ((backup.worlds?.length || 0) || (backup.resources?.length || 0)) throw new Error('请使用不含世界书文件和词库的设置迁移文件。');
  updateConfig(structuredClone(DEFAULT_CONFIG), config);
  return { config };
}
