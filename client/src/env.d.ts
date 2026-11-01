/// <reference types="vite/client" />

declare module "virtual:updates" {
  const updates: { n: number; date: string; title: string; line: string; image: string }[];
  export default updates;
}
