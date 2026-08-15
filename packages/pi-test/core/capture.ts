export function compileCapturePattern(source: string): RegExp {
  if (
    !source ||
    source.length > 500 ||
    /\0|\\[1-9]|\(\?[<!=:]|\{[^}]*,|(?:\*|\+|\?){2}|\([^)]*[+*][^)]*\)[+*?]/.test(source)
  ) {
    throw new Error("capture pattern 不支持复杂或高风险正则");
  }
  let groups = 0;
  let escaped = false;
  let inClass = false;
  for (const char of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "(" && !inClass) groups += 1;
  }
  if (groups !== 1) throw new Error("capture pattern 必须且只能有一个捕获组");
  try {
    return new RegExp(source);
  } catch {
    throw new Error("capture pattern 无效");
  }
}
