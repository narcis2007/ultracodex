// Writes UTF-8 text to stdout and stderr one byte at a time, with a pause between the first bytes, so
// that every multibyte character (a Romanian diacritic is two bytes) reaches the reader split across
// chunks. The text is the first argument.
const text = process.argv[2] ?? "";
const bytes = Buffer.from(text, "utf8");
const pause = () => new Promise((resolve) => setTimeout(resolve, 4));
for (let at = 0; at < bytes.length; at += 1) {
  process.stdout.write(bytes.subarray(at, at + 1));
  process.stderr.write(bytes.subarray(at, at + 1));
  if (at < 80) await pause();
}
process.stdout.write("\n");
