// ESM loader hook used only by `pnpm test` to make `.css` /
// `.module.css` imports resolvable. Node and tsx don't know how to load
// CSS, but the components under test only consume CSS-module imports as
// a `styles` object (`styles.shell`, `styles.summaryRed`, …). The
// loader returns an identity proxy so every class lookup yields its
// own key as a string — enough for tests to assert that the component
// chose the right class.

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    // Short-circuit; we don't care about an on-disk file, just give it
    // a stable URL so the load hook can recognize it.
    const parentUrl = context.parentURL ?? "file:///";
    return {
      url: new URL(specifier, parentUrl).href,
      format: "module",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return {
      format: "module",
      source:
        "const _styles = new Proxy({}, { get: (_t, k) => typeof k === 'string' ? k : '' });\n" +
        "export default _styles;\n",
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
