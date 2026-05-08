// Bun supports `import x from "./foo.py" with { type: "text" }` and bakes the
// raw source string into the bundle at compile time. TypeScript doesn't know
// about this loader by default, so declare the module shape ourselves.
declare module "*.py" {
  const content: string;
  export default content;
}
