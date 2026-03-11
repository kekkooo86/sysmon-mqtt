/**
 * Resolves {prefix} placeholder in a topic template.
 * If prefix is empty, strips the {prefix}/ part to avoid a leading slash.
 * Double slashes are collapsed as a safety net.
 */
function resolveTopic(template, prefix) {
  const p = (prefix || '').replace(/\/+$/, ''); // trim trailing slashes
  const resolved = p
    ? template.replace(/\{prefix\}/g, p)
    : template.replace(/\{prefix\}\//g, '');
  return resolved.replace(/\/\//g, '/');
}

module.exports = { resolveTopic };
