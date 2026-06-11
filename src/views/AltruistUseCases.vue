<template>
  <MetaInfo
    :pageTitle="$t('Who Altruist Was Created For - Sensors use cases')"
    :pageDescription="
      $t(
        'Monitoring the environment involves plenty of pitfalls, making the job far harder than it looks at first glance. Our team—the creators of Altruist and the open-source project sensors.social—has spent seven years studying and working in this field, and we hope our experience will pleasantly surprise you and give you a practical tool for adapting to the conditions in which you and your loved ones live. Below we explain which main user groups Altruist is designed for…'
      )
    "
    pageImage="/og-altruist-use-cases.webp"
  />
  <PageTextLayout>
    <div class="pagetext-prose">
      <div class="pagetext-header">
        <div class="pagetext-eyebrow">sensors.social</div>
        <h1 class="pagetext-title">{{ $t("Who Altruist Was Created For") }}</h1>
        <p class="pagetext-subtitle">
          {{
            $t(
              "Monitoring the environment involves plenty of pitfalls, making the job far harder than it looks at first glance. Our team—the creators of Altruist and the open-source project sensors.social—has spent seven years studying and working in this field, and we hope our experience will pleasantly surprise you and give you a practical tool for adapting to the conditions in which you and your loved ones live. Below we explain which main user groups Altruist is designed for…"
            )
          }}
        </p>
      </div>

      <section>
        <h2>🏙️ {{ $t("You live in a big city or an ecologically challenged region") }}</h2>
        <p><img :src="image1" alt="" /></p>
        <p>
          {{
            $t(
              "Think of it as a little adventure: getting to know your city better. The top-priority reason to buy a home air-quality station is to gain solid knowledge of what is happening indoors and outside throughout the year so you can adapt accordingly."
            )
          }}
        </p>
        <p>
          {{
            $t(
              "There’s always something to worry about, but it’s best not to let the extremes—“nothing is happening” vs. “everything is definitely bad”—take root. After seven years working with citizen air-quality monitoring around the world, we can assure you that personal, quantitative monitoring shows the real situation right where you live. After a year with Altruist you will see, in clear graphs with insights from the developers, how air quality varies by time of day, season, the operation of waste-incineration plants, industrial sites, power stations, seasonal fires, dust storms… and you’ll form an objective view of what is happening right outside your window—and adapt to it."
            )
          }}
        </p>

        <details class="details-link">
          <summary>{{ $t("Altruist features for urban conditions") }}</summary>
          <ul>
            <li>
              <b>{{ $t("Street-grade particle sensor") }}</b> —
              {{
                $t(
                  "tough enough to hang outside yet still fine indoors. If you mount Altruist Urban outside your window it won’t “choke” after the first sand truck rumbles past."
                )
              }}
            </li>
            <li>
              <b>{{ $t("Outdoor noise measurement") }}</b> —
              {{
                $t(
                  "Altruist is currently the only product in its class that adds a city-grade noise sensor, covering another important urban factor."
                )
              }}
            </li>
          </ul>
        </details>
      </section>

      <section>
        <h2>🤧🌿 {{ $t("You or your loved ones have allergies or bronchial asthma") }}</h2>
        <p><img :src="image2" alt="" /></p>
        <p>
          {{
            $t(
              "Some of Altruist’s developers suffer from house-dust allergy; one of us spent childhood in hospital every few weeks with asthma attacks. Life is harder for such people, so it is especially important to help them control indoor air quality."
            )
          }}
        </p>

        <details class="details-link">
          <summary>{{ $t("How Altruist helps allergy and asthma sufferers") }}</summary>
          <ul>
            <li>
              <b>{{ $t("Room profiling") }}</b>
              {{
                $t(
                  "for particulate matter and humidity: in the first week you will get 24-hour snapshots with highlighted insights—graphs that let you compare rooms instead of staring at bare numbers."
                )
              }}
            </li>
            <li>
              <b>{{ $t("Ventilation hints") }}</b>
              {{
                $t(
                  "an Altruist on the balcony or even on a windowsill will warn you when outdoor air is bad so you can close the windows, turn on the purifier and postpone walks until traffic or a dust storm subsides."
                )
              }}
            </li>
            <li>
              <b>{{ $t("Children’s rooms") }}</b>
              {{
                $t(
                  "place a unit there to spot dust problems early and reduce the risk of developing dust allergy."
                )
              }}
            </li>
          </ul>
        </details>
      </section>

      <section>
        <h2>🛠️🏠 {{ $t("You are building a smart home") }}</h2>
        <p><img :src="image3" alt="" /></p>
        <p>
          {{
            $t(
              "Most of our team are engineers who automate their homes. We provide an official integration in Home Assistant Store so you can add Altruist to your local smart-home setup in two clicks, plus ready-made automation blueprints that need no coding."
            )
          }}
        </p>

        <details class="details-link">
          <summary>{{ $t("How Altruist is useful for a DIY smart-home engineer") }}</summary>
          <ul>
            <li>
              <b>{{ $t("RGB lamp indicator") }}</b> —
              {{
                $t(
                  "link any parameter to a smart bulb so your room quietly signals changes (no need to turn the whole living-room red just because Grandpa lights his pipe on the balcony)."
                )
              }}
            </li>
            <li>
              <b>{{ $t("Air-purifier trigger") }}</b> —
              {{ $t("start a purifier inside whenever the outdoor unit detects smoke or dust.") }}
            </li>
            <li>
              <b>{{ $t("Air-conditioner control") }}</b> —
              {{ $t("react automatically to rising outdoor humidity or temperature at dawn.") }}
            </li>
          </ul>
        </details>
      </section>

      <section>
        <h2>
          🕵️‍♂️📈
          {{
            $t(
              "You like to support community initiatives independent of governments and corporations"
            )
          }}
        </h2>
        <p><img :src="image4" alt="" /></p>
        <p>
          {{
            $t(
              "Become a data source and join other Altruists to build a citizen network monitoring environmental issues in your region. The developers have open-sourced the entire sensors.social backend so local communities can launch an independent sensor map."
            )
          }}
        </p>

        <details class="details-link">
          <summary>{{ $t("How Altruist helps independent monitoring") }}</summary>
          <ul>
            <li>
              <b>{{ $t("Trusted hardware") }}</b> —
              {{
                $t(
                  "open-source and field-tested by thousands of users, easy to recommend to neighbours."
                )
              }}
            </li>
            <li>
              <b>{{ $t("Your own map in one day") }}</b> —
              {{
                $t(
                  "clone the GitHub repo, deploy on any domain and run a fully independent service that even the Altruist developers can’t interfere with."
                )
              }}
            </li>
          </ul>
        </details>
      </section>

      <section class="pagetext-highlight">
        <p>
          {{
            $t(
              "The most fascinating lesson from seven years of experiments is the sheer diversity of motives, methods and analysis styles in environmental monitoring—from health concerns to activism, from outdated test tubes to high-end sampling stations, from smiley-faces to daily graphs. It all makes the task far more complex than it first appears, but we hope our team’s perspective embodied in Altruist and sensors.social will delight you and give you a useful tool for adapting to your environment."
            )
          }}
        </p>
      </section>
    </div>

    <div class="pagetext-wide-1920 pagetext-no-text-all">
      <AltruistCompare />
    </div>
  </PageTextLayout>
</template>

<script setup>
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import MetaInfo from "../components/MetaInfo.vue";
import AltruistCompare from "../components/devices/altruist/AltruistCompare.vue";
import PageTextLayout from "../components/layouts/PageText.vue";

import { useI18n } from "vue-i18n";

import image1Def from "@/assets/images/pages/altruist-use-cases/altruist-use-cases-1.webp";
import image2Def from "@/assets/images/pages/altruist-use-cases/altruist-use-cases-2.webp";
import image3Def from "@/assets/images/pages/altruist-use-cases/altruist-use-cases-3.webp";
import image4Def from "@/assets/images/pages/altruist-use-cases/altruist-use-cases-4.webp";
import image1Ru from "@/assets/images/pages/altruist-use-cases/ru/altruist-use-cases-1.webp";
import image2Ru from "@/assets/images/pages/altruist-use-cases/ru/altruist-use-cases-2.webp";
import image3Ru from "@/assets/images/pages/altruist-use-cases/ru/altruist-use-cases-3.webp";
import image4Ru from "@/assets/images/pages/altruist-use-cases/ru/altruist-use-cases-4.webp";

const { locale: i18nLocale } = useI18n();

const locale = computed(() => {
  return i18nLocale.value || localStorage.getItem("locale") || "en";
});

const image1 = computed(() => {
  return locale.value === "ru" ? image1Ru : image1Def;
});

const image2 = computed(() => {
  return locale.value === "ru" ? image2Ru : image2Def;
});

const image3 = computed(() => {
  return locale.value === "ru" ? image3Ru : image3Def;
});

const image4 = computed(() => {
  return locale.value === "ru" ? image4Ru : image4Def;
});

const router = useRouter();

onMounted(() => {
  const waitForMatomo = setInterval(() => {
    if (typeof window.Matomo !== "undefined" && typeof window.Matomo.getTracker === "function") {
      clearInterval(waitForMatomo);

      const trackPage = () => {
        const tracker = window.Matomo.getTracker();
        if (tracker && !tracker.isUserOptedOut()) {
          window._paq.push(["setCustomUrl", router.currentRoute.value.fullPath]);
          window._paq.push(["setDocumentTitle", document.title]);
          window._paq.push(["trackPageView"]);
        }
      };

      // Track the initial page load
      trackPage();
    }
  }, 100);
});
</script>

<style scoped>
.container-pagetext section:last-child {
  margin-bottom: calc(var(--gap) * 3);
}
</style>
