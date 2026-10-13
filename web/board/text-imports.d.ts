// Files imported as text (Bun's `with { type: "text" }`): a stylesheet's CSS.
declare module "*.css" {
  const text: string;
  export default text;
}
