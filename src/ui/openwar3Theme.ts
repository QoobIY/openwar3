export const OPENWAR3_FONT = '"Segoe UI", "Noto Sans", "Nowar Sans", system-ui, sans-serif';

export function gameplayIcon(path: string): boolean {
  return /(?:commandbuttons|items|abilities|spells|units|resource|gold|lumber|supply|food|mana)/i.test(path);
}

export function applyOpenWar3Theme(_vfs?: unknown, _race?: unknown): void {
  document.body.classList.add("ow3-ui");
  document.documentElement.style.setProperty("--game-font", '"Segoe UI", "Noto Sans", "Nowar Sans", system-ui, sans-serif');
  document.documentElement.style.setProperty("--ui-font", '"Segoe UI", "Noto Sans", "Nowar Sans", system-ui, sans-serif');
}
