import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "Melbourne Transport Map",
    description:
      "Internal documentation for the real-time transport visualisation",
    base: "/",

    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Architecture", link: "/architecture" },
        { text: "Changelog", link: "/changelog" },
      ],

      sidebar: [
        {
          text: "Guide",
          items: [
            { text: "Overview", link: "/" },
            { text: "Setup", link: "/setup" },
            { text: "Architecture", link: "/architecture" },
            { text: "Data Flow", link: "/data-flow" },
            { text: "Changelog", link: "/changelog" },
          ],
        },
      ],

      socialLinks: [
        {
          icon: "github",
          link: "https://github.com/tensorfish/trams-melbourne",
        },
      ],
    },

    mermaid: {},
  })
);
