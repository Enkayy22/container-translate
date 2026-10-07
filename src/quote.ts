export function quoteArg(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(argv: string[]): string {
  return argv.map(quoteArg).join(' ');
}
