import {defineConfig} from "vitest/config";

// Next compiles JSX itself (tsconfig "jsx": "preserve"); tests render with React's automatic runtime, as Next does.
export default defineConfig({esbuild:{jsx:"automatic"},test:{include:["test/**/*.test.ts"]}});
