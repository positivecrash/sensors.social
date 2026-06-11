<template>
  <MetaInfo
    :pageTitle="$t('Noise Data for Real Estate: Negotiate with Facts, Not Feelings')"
    :pageDescription="
      $t(
        'How a month of noise monitoring with Altruist can strengthen your position in rent or purchase negotiations. Real examples from Limassol, Cyprus.'
      )
    "
    pageImage="/og-noise-data.webp"
  />
  <PageTextLayout>
    <div class="pagetext-prose">
      <div class="pagetext-header">
        <div class="pagetext-eyebrow">sensors.social</div>
        <h1 class="pagetext-title">
          {{ $t("Noise Data for Real Estate: Negotiate with Facts, Not Feelings") }}
        </h1>
        <p class="pagetext-subtitle">
          {{
            $t(
              'Saying "the construction is loud" is an opinion. Showing a month-long noise graph with daily peaks above 90 dB is evidence. We believe real sensor data fundamentally changes the context of housing negotiations — whether you are renting or buying.'
            )
          }}
        </p>
      </div>

      <section>
        <h2>{{ $t("The Hypothesis") }}</h2>
        <p>
          {{
            $t(
              "Imagine you have a noise sensor on your balcony. Over a month, it builds a complete noise pollution profile — 24/7, day and night. When it's time to renegotiate your lease, you come to the table not with feelings, but with data."
            )
          }}
        </p>
        <p>
          {{
            $t(
              "Your landlord sees daily graphs with red and orange spikes. They can choose to ignore it — but it's much harder to dismiss a chart with clear explanations of how harmful these levels are, especially when the data is publicly available on an environmental monitoring map."
            )
          }}
        </p>
        <p>
          {{
            $t(
              "And here's the real leverage: if the landlord doesn't make concessions, how easy will it be to re-rent a place when prospective tenants can see the noise profile themselves?"
            )
          }}
        </p>
      </section>

      <section>
        <h2>{{ $t("Real Example: Two Neighborhoods in Limassol") }}</h2>
        <p>
          {{
            $t(
              "Below are actual measurements from Altruist sensors installed on balconies of two residential buildings in Limassol, Cyprus. Both are premium-class properties — but the noise tells very different stories."
            )
          }}
        </p>

        <h3>{{ $t("Neapoli (Molos area) — noisy") }}</h3>
        <p>
          <img
            :src="imageNeapoli"
            alt="Noise data from Neapoli, Limassol — peaks above 90 dB"
            class="pagetext-fullwidth-image"
          />
        </p>
        <p>
          {{
            $t(
              "Noise regularly exceeds 70 dB during the day and spikes above 90 dB — equivalent to standing next to a running lawnmower. The WHO considers prolonged exposure above 65 dB harmful to cardiovascular health."
            )
          }}
        </p>

        <h3>{{ $t("Germasogeia — quiet") }}</h3>
        <p>
          <img
            :src="imageGermasogeia"
            alt="Noise data from Germasogeia — stable 50-60 dB"
            class="pagetext-fullwidth-image"
          />
        </p>
        <p>
          {{
            $t(
              "Daytime noise stays within a comfortable 50–60 dB range. This is the sound level of a normal conversation — perfectly acceptable for residential living."
            )
          }}
        </p>

        <p class="pagetext-highlight">
          {{
            $t(
              "Same city, similar building class — but entirely different quality of life. These graphs alone influenced a real decision about where to live."
            )
          }}
        </p>
      </section>

      <section>
        <h2>{{ $t("It Works Both Ways") }}</h2>
        <p>
          {{
            $t(
              "Noise data isn't just about complaints. If your balcony sensor shows six months or a year of consistently low noise, that's a selling point. Your apartment rents faster and at a higher price."
            )
          }}
        </p>
        <p>
          {{
            $t(
              "For property sales, we believe noise and air quality data from the balcony is already a must-have — like an energy efficiency certificate, but for livability."
            )
          }}
        </p>
      </section>

      <section>
        <h2>{{ $t("How to Try This Yourself") }}</h2>
        <ol>
          <li>
            {{ $t("Mount an Altruist sensor on your balcony or outside your window.") }}
          </li>
          <li>
            {{
              $t(
                "Collect data for at least one month — the sensor measures noise, air quality, temperature, and humidity 24/7."
              )
            }}
          </li>
          <li>
            {{
              $t(
                "Your data appears on the public sensors.social map — accessible to anyone, verifiable, and tamper-proof."
              )
            }}
          </li>
          <li>
            {{ $t("Present the graphs at your next negotiation. Let the data speak.") }}
          </li>
        </ol>
      </section>

      <section class="pagetext-highlight">
        <p>
          {{
            $t(
              "Want to try this approach? Get an Altruist sensor, mount it on your balcony, and collect a month of data. Then use the graphs in your next housing negotiation — and see how facts change the conversation."
            )
          }}
        </p>
      </section>
    </div>
  </PageTextLayout>
</template>

<script setup>
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import MetaInfo from "../components/MetaInfo.vue";
import PageTextLayout from "../components/layouts/PageText.vue";

import imageNeapoli from "@/assets/images/pages/noise-data-real-estate/neapoli-noise.webp";
import imageGermasogeia from "@/assets/images/pages/noise-data-real-estate/germasogeia-noise.webp";

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

      trackPage();
    }
  }, 100);
});
</script>
