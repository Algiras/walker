/** Gives up on work that never finishes, so one stuck phrase cannot hold back every later one. */
export function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
