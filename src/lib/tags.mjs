export const normalizeTag = (value) => String(value)
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/[\s_]+/g, '-')
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

export const tagUrl = (tag, base = '') => {
  const prefix = base.replace(/\/$/, '');
  return `${prefix}/tags/${encodeURIComponent(normalizeTag(tag))}/`;
};
