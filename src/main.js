import { Buffer } from "buffer";
import { createApp } from "vue";
import { createHead } from "@vueuse/head";
import App from "./App.vue";
import { usePlugins } from "./plugins";
import InstagramEmbed from "./components/blog/InstagramEmbed.vue";

import "./assets/styles/main.css";

window.Buffer = Buffer;

async function bootstrap() {
  if (!("popover" in HTMLElement.prototype)) {
    await import("@oddbird/popover-polyfill");
  }

  const app = createApp(App).use(createHead());
  usePlugins(app);

  // for blog
  app.component("InstagramEmbed", InstagramEmbed);

  app.mount("#app");
}

bootstrap();
