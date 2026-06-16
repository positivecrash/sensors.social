<template>
  <section>
    <p>
      <a
        href="https://github.com/airalab/sensors.robonomics.network"
        target="_blank"
        rel="noopener"
      >
        <b>{{ repoName }} {{ latestRelease }}</b>
      </a>
    </p>
    <div>
      <b>{{ $t("Secured by") }}</b>
    </div>
    <img alt="" src="../assets/images/polkadot-new-dot-logo-horizontal.svg" class="polkadotLogo" />
  </section>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { settings } from "@config";
import { fetchLatestGithubRelease } from "@/utils/githubRelease";

const repoName = ref(settings.REPO_NAME);
const latestRelease = ref("loading...");

onMounted(async () => {
  try {
    latestRelease.value = await fetchLatestGithubRelease(repoName.value);
  } catch (e) {
    console.error("Error fetching latest release:", e);
    latestRelease.value = "";
  }
});
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
