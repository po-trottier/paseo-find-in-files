export function withAlpha(color: string, alpha: string): string {
  if (/^#[\da-f]{3,4}$/i.test(color)) {
    const [red, green, blue] = color.slice(1);
    return `#${red}${red}${green}${green}${blue}${blue}${alpha}`;
  }
  if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) {
    return `${color.slice(0, 7)}${alpha}`;
  }
  return color;
}
