const mask = (value) => value.replace(/[^\r\n]/g, ' ');

export const stripNonContent = (markdown) => markdown
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?(?:\n|$)/, mask)
  .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, mask)
  .replace(/`[^`\r\n]*`/g, mask)
  .replace(/\$\$[\s\S]*?\$\$/g, mask)
  .replace(/(?<!\\)\$[^$\r\n]+(?<!\\)\$/g, mask)
  .replace(/\\\([\s\S]*?\\\)/g, mask)
  .replace(/\\\[[\s\S]*?\\\]/g, mask);

const WIKILINK = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;

export const extractWikilinks = (markdown) => {
  const links = [];
  for (const match of stripNonContent(markdown).matchAll(WIKILINK)) {
    links.push({ target: match[1].trim(), label: match[2]?.trim() });
  }
  return links;
};
