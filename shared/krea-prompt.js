/* Plain-text prompts for Krea 2; preserve descriptions, remove extension metadata.
 * Aladdin Free Public License; see ../LICENSE.
 */
export function cleanKrea2Prompt(value) {
  if (typeof value !== 'string') return value;
  const hasRoleMarkers = /\|\s*centers\s*[:：]/i.test(value);
  let text = value
    // Empty positions and the upstream a1–e5 grid are not Krea regional controls.
    .replace(/\|\s*centers\s*[:：][ \t]*(?:[a-e][1-5](?:[ \t]*,[ \t]*[a-e][1-5])*)?[ \t]*(?=[|;\r\n]|$)/gi, '')
    // Only standalone size fields. Keep measurements and dimensions in prose.
    .replace(/(^|[,，;；|\r\n])[ \t]*\d{3,4}[ \t]*[xX×*][ \t]*\d{3,4}[ \t]*(?=[,，;；|\r\n]|$)/g, '$1');
  if (hasRoleMarkers) text = text.replace(/[ \t]*\|[ \t]*/g, '\n\n');
  return text.replace(/[,，][ \t]*(?=[,，;；|\r\n]|$)/g, '')
    .replace(/^[ \t]*[,，;；]+[ \t]*/gm, '').replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function parseKrea2Roles(value) {
  if (typeof value !== 'string') return null;
  const fields = [...value.matchAll(/(?:^|[;；\r\n])[ \t]*(Scene Composition|Character ([1-4]) (Prompt|UC))[ \t]*[:：]/gi)];
  if (!fields.length) return null;
  const roles = { 'Scene Composition': value.slice(0, fields[0].index).trim() };
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const name = field[2] ? `Character ${field[2]} ${field[3].toUpperCase() === 'UC' ? 'UC' : 'Prompt'}` : 'Scene Composition';
    const content = value.slice(field.index + field[0].length, fields[i + 1]?.index ?? value.length).trim().replace(/[;；]+$/, '').trim();
    const cleaned = cleanKrea2Prompt(content);
    roles[name] = [roles[name], cleaned].filter(Boolean).join('\n\n');
  }
  return roles;
}
