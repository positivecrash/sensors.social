<template>
  <section>
    <p>
      <a :href="releasesUrl" target="_blank" rel="noopener">
        <b>{{ repoName }} {{ releaseTag }}</b>
      </a>
    </p>
    <div>
      <b>{{ $t("Secured by") }}</b>
    </div>
    <img alt="" src="../assets/images/polkadot-new-dot-logo-horizontal.svg" class="polkadotLogo" />
  </section>
</template>

<script setup>
import { computed } from "vue";
import { settings } from "@config";
import { version } from "../../package.json";

const repoName = settings.REPO_NAME;
const releaseTag = computed(() => `v${version}`);
const releasesUrl = computed(() => `https://github.com/${repoName}/releases/tag/v${version}`);
</script>

<style scoped>
.polkadotLogo {
  display: inline-block;
  max-width: 100px;
}

section {
  text-align: center;
}
</style>
