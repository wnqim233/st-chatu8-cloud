/* Reuse upstream character presets without changing layout or shared UI state.
 * Aladdin Free Public License; see ../LICENSE.
 */
export function expandCloudCharacters(prompt, resolve, state) {
  if (typeof prompt !== 'string' || !/\$[^$]+\$/.test(prompt)) return { prompt, negative: '' };
  const hadNegative = Object.hasOwn(state, 'collectedCharacterNegatives');
  const previous = state.collectedCharacterNegatives;
  try {
    const expanded = resolve(prompt, { preserveLayout: true, parseRoles: false });
    return { prompt: expanded, negative: state.collectedCharacterNegatives || '' };
  } finally {
    if (hadNegative) state.collectedCharacterNegatives = previous;
    else delete state.collectedCharacterNegatives;
  }
}
