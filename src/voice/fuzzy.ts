export const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

export const closeEnough = (a: string, b: string) => {
  const d = lev(a, b);
  return d <= 2 && d / Math.max(a.length, b.length) <= 0.4;
};

/** Game words within two letters of a pad name: "delete" is not Delta, "home" is not Hotel, "gold" is not Golf. */
const NOT_PADS = new Set(["delete", "home", "gold"]);

/** Does the text mention this pad by name, allowing for misheard spellings such as Alfa for Alpha, or Fox trot for Foxtrot? */
export const mentions = (words: string[], name: string) => {
  const pad = name.toLowerCase();
  return words.some((w, i) => w === pad || (i > 0 && words[i - 1] + w === pad) || (w.length > 3 && !NOT_PADS.has(w) && closeEnough(w, pad)));
};
