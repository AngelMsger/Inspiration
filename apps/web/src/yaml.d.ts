// The Vite config turns a language pack into a module whose default export is its words.
declare module "*.yaml" {
  const words: Record<string, string>;
  export default words;
}
