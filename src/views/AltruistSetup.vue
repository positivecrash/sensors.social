<template>
  <MetaInfo
    :pageTitle="$t('Altruist Setup Guide — Urban & Insight')"
    :pageDescription="
      $t(
        'Step-by-step setup instructions for Altruist Urban outdoor sensor and Altruist Insight indoor monitor. Connect to Wi-Fi, configure GPS, and join the open sensor map.'
      )
    "
    pageImage="/og-altruist-setup.webp"
  />
  <PageTextLayout>
    <div class="pagetext-prose">
      <div class="pagetext-header">
        <div class="pagetext-eyebrow">sensors.social</div>
        <h1 class="pagetext-title">{{ $t("Altruist Setup Guide") }}</h1>
        <p class="pagetext-subtitle">
          {{
            $t(
              "Follow these steps to set up your Altruist sensor and connect it to the open sensor network at sensors.social."
            )
          }}
        </p>
      </div>

      <nav class="setup-nav">
        <a class="setup-navlink" href="#urban">{{ $t("Altruist Urban") }}</a>
        <a class="setup-navlink" href="#insight">{{ $t("Altruist Insight") }}</a>
        <a class="setup-navlink" href="#uv-cover">{{ $t("UV Cover") }}</a>
        <a class="setup-navlink" href="#specs">{{ $t("Technical Specifications") }}</a>
      </nav>

      <!-- ==================== URBAN SETUP ==================== -->
      <section id="urban">
        <h2>{{ $t("Set Up Your Altruist Urban") }}</h2>

        <div class="setup-intro">
          <div>
            <p>
              {{
                $t(
                  "Altruist Urban is an outdoor air quality monitor measuring particulate matter (PM2.5 / PM10), temperature, humidity, atmospheric pressure, and noise level."
                )
              }}
            </p>
            <a href="/altruist-urban-setup.pdf" target="_blank" class="button">
              <font-awesome-icon icon="fa-solid fa-download" />
              {{ $t("Download PDF instruction") }}
            </a>
          </div>
          <img :src="urbanHero" :alt="$t('Altruist Urban device')" class="setup-hero" />
        </div>

        <details class="setup-fulldiagram" open>
          <summary>{{ $t("Full setup diagram") }}</summary>
          <img
            :src="urbanFullDiagram"
            :alt="$t('Altruist Urban full setup diagram')"
            class="setup-diagram"
          />
        </details>

        <h3>{{ $t("Step 1 — Power") }}</h3>
        <div class="step-with-image">
          <div>
            <p>
              {{ $t("Connect the sensor to a USB-C power source. Minimum requirement: 5V / 1A.") }}
            </p>
          </div>
          <img
            :src="urbanStep1"
            :alt="$t('Power connection')"
            class="step-image step-image--small"
          />
        </div>

        <h3>{{ $t("Step 2 — Connect to the Altruist") }}</h3>
        <div class="step-with-image">
          <div>
            <ol>
              <li>
                {{
                  $t(
                    "Scan the QR code with your phone camera, or find the Wi-Fi network «Altruist-xxxxxxxxx» in your device settings."
                  )
                }}
              </li>
              <li>{{ $t("The access point becomes active shortly after powering on.") }}</li>
              <li>{{ $t("Enter the password:") }} <code>123456789</code></li>
            </ol>
          </div>
          <img :src="urbanStep2" :alt="$t('Connect to Altruist Wi-Fi')" class="step-image" />
        </div>

        <h3>{{ $t("Step 3 — Connect to Your Wi-Fi") }}</h3>
        <img :src="urbanStep3" :alt="$t('Wi-Fi configuration')" class="step-image-wide" />
        <ol>
          <li><b>3.1</b> {{ $t("Open your browser and go to") }} <code>192.168.4.1</code></li>
          <li>{{ $t("Enter your home Wi-Fi network name and password in «WIFI SETTINGS».") }}</li>
          <li>{{ $t("Click «Save configuration and restart».") }}</li>
          <li>
            <b>3.2</b>
            {{
              $t(
                "After restart the device shows status «CONNECTED!» and a new IP address (e.g. 192.168.10.3)."
              )
            }}
          </li>
          <li>{{ $t("Copy the new IP address of the Altruist.") }}</li>
        </ol>

        <h3>{{ $t("Step 4 — Connect to the Sensor Map") }}</h3>
        <div class="step-images-row">
          <img :src="urbanStep4map" :alt="$t('Sensor map configuration')" class="step-image-wide" />
          <img :src="urbanStep4gps" :alt="$t('GPS configuration')" class="step-image-wide" />
        </div>
        <ol>
          <li>
            <b>4.1</b> {{ $t("Open the new IP address in your browser. Click «Configuration».") }}
          </li>
          <li>
            <b>4.2</b>
            {{
              $t("Go to «GPS & Sensors» and enter the GPS coordinates of your sensor's location.")
            }}
          </li>
          <li>
            {{ $t("Use") }}
            <a
              href="https://www.latlong.net/convert-address-to-lat-long.html"
              target="_blank"
              rel="noopener"
              >latlong.net</a
            >
            {{ $t("to find coordinates by address.") }}
          </li>
          <li>{{ $t("Click «Save configuration and restart».") }}</li>
        </ol>

        <p class="pagetext-highlight">
          {{ $t("Done! After a few minutes your sensor will appear on the open sensor map at") }}
          <a href="https://sensors.social" target="_blank" rel="noopener">sensors.social</a>
        </p>

        <h3>{{ $t("Mounting") }}</h3>
        <div class="step-with-image step-with-image--reverse">
          <div>
            <p>
              {{ $t("You can mount the sensor on a vertical surface using the included holder.") }}
            </p>
            <ul>
              <li>
                {{
                  $t(
                    "Mounting is optional — the Altruist is stable on any flat horizontal surface."
                  )
                }}
              </li>
              <li>
                {{
                  $t(
                    "For UV protection from direct sunlight, we recommend an additional sun visor."
                  )
                }}
              </li>
              <li>
                {{
                  $t(
                    "Wall mount (adhesive sticker): max height 3 m, operating temperature −10 °C to +35 °C."
                  )
                }}
              </li>
              <li>{{ $t("Recommended installation height: 3 m or above.") }}</li>
            </ul>
          </div>
          <img :src="urbanMounting" :alt="$t('Mounting instructions')" class="step-image" />
        </div>

        <h3>{{ $t("Connect to Home Assistant") }}</h3>
        <div class="step-with-image">
          <div>
            <p>
              {{
                $t(
                  "Home Assistant integration lets you track air quality directly in your automation system. You can also create automation scenarios with other devices in your home."
                )
              }}
            </p>
            <p>
              {{ $t("Step-by-step guide:") }}
              <a
                href="https://wiki.robonomics.network/docs/altruist/#home-assistant"
                target="_blank"
                rel="noopener"
              >
                wiki.robonomics.network/docs/altruist/#home-assistant
              </a>
            </p>
          </div>
          <img :src="urbanHA" :alt="$t('Home Assistant integration')" class="step-image" />
        </div>
      </section>

      <!-- ==================== INSIGHT SETUP ==================== -->
      <section id="insight">
        <h2>{{ $t("Set Up Your Altruist Insight") }}</h2>

        <div class="setup-intro">
          <div>
            <p>
              {{
                $t(
                  "Altruist Insight is an indoor air quality monitor with an e-ink display, measuring CO2, temperature, humidity, and atmospheric pressure."
                )
              }}
            </p>
            <a href="/altruist-insight-setup.pdf" target="_blank" class="button">
              <font-awesome-icon icon="fa-solid fa-download" />
              {{ $t("Download PDF instruction") }}
            </a>
          </div>
          <img :src="insightHero" :alt="$t('Altruist Insight device')" class="setup-hero" />
        </div>

        <details class="setup-fulldiagram" open>
          <summary>{{ $t("Full setup diagram") }}</summary>
          <img
            :src="insightFullDiagram"
            :alt="$t('Altruist Insight full setup diagram')"
            class="setup-diagram"
          />
        </details>

        <h3>{{ $t("Step 1 — Power") }} &amp; {{ $t("Step 2 — Connect to the Altruist") }}</h3>
        <img :src="insightStep12" :alt="$t('Power and connection')" class="step-image-wide" />
        <ol>
          <li>
            {{ $t("Connect the sensor to a USB-C power source. Minimum requirement: 5V / 1A.") }}
          </li>
          <li>
            {{
              $t(
                "Scan the QR code with your phone camera, or find the Wi-Fi network «Altruist-xxxxxxxxx» in your device settings."
              )
            }}
          </li>
          <li>{{ $t("The access point becomes active shortly after powering on.") }}</li>
          <li>{{ $t("Enter the password:") }} <code>123456789</code></li>
        </ol>

        <h3>{{ $t("Step 3 — Connect to Your Wi-Fi") }}</h3>
        <img :src="insightStep3" :alt="$t('Wi-Fi configuration')" class="step-image-wide" />
        <ol>
          <li><b>3.1</b> {{ $t("Open your browser and go to") }} <code>192.168.4.1</code></li>
          <li>{{ $t("Enter your home Wi-Fi network name and password in «WIFI SETTINGS».") }}</li>
          <li>{{ $t("Click «Save configuration and restart».") }}</li>
          <li>
            <b>3.2</b>
            {{
              $t(
                "After restart the device shows status «CONNECTED!» and a new IP address (e.g. 192.168.10.3)."
              )
            }}
          </li>
          <li>{{ $t("Copy the new IP address of the Altruist.") }}</li>
        </ol>

        <h3>{{ $t("Step 4 — Connect to the Sensor Map") }}</h3>
        <div class="step-images-row">
          <img
            :src="insightStep4map"
            :alt="$t('Sensor map configuration')"
            class="step-image-wide"
          />
          <img :src="insightStep4gps" :alt="$t('GPS configuration')" class="step-image-wide" />
        </div>
        <ol>
          <li>
            <b>4.1</b> {{ $t("Open the new IP address in your browser. Click «Configuration».") }}
          </li>
          <li>
            <b>4.2</b>
            {{
              $t("Go to «GPS & Sensors» and enter the GPS coordinates of your sensor's location.")
            }}
          </li>
          <li>
            {{ $t("Use") }}
            <a
              href="https://www.latlong.net/convert-address-to-lat-long.html"
              target="_blank"
              rel="noopener"
              >latlong.net</a
            >
            {{ $t("to find coordinates by address.") }}
          </li>
          <li>{{ $t("Click «Save configuration and restart».") }}</li>
        </ol>

        <p class="pagetext-highlight">
          {{ $t("Done! After a few minutes your sensor will appear on the open sensor map at") }}
          <a href="https://sensors.social" target="_blank" rel="noopener">sensors.social</a>
        </p>

        <h3>{{ $t("E-ink Display") }}</h3>
        <div class="step-with-image step-with-image--reverse">
          <div>
            <p>
              {{
                $t(
                  "The display shows data from your Altruist Insight sensor and a connected Altruist Urban sensor on the same Wi-Fi network."
                )
              }}
            </p>
            <ul>
              <li>{{ $t("LEDs around the perimeter indicate the current air quality level.") }}</li>
              <li>
                {{ $t("Three buttons on the back panel let you switch screens and browse data.") }}
              </li>
            </ul>
          </div>
          <img :src="insightEink" :alt="$t('E-ink display')" class="step-image" />
        </div>

        <h3>{{ $t("Connect to Home Assistant") }}</h3>
        <div class="step-with-image">
          <div>
            <p>
              {{
                $t(
                  "Home Assistant integration lets you track air quality directly in your automation system. You can also create automation scenarios with other devices in your home."
                )
              }}
            </p>
            <p>
              {{ $t("Step-by-step guide:") }}
              <a
                href="https://wiki.robonomics.network/docs/altruist/#home-assistant"
                target="_blank"
                rel="noopener"
              >
                wiki.robonomics.network/docs/altruist/#home-assistant
              </a>
            </p>
          </div>
          <img :src="insightHA" :alt="$t('Home Assistant integration')" class="step-image" />
        </div>
      </section>

      <!-- ==================== UV COVER ==================== -->
      <section id="uv-cover">
        <h2>{{ $t("UV Cover for Altruist Urban") }}</h2>
        <div class="step-with-image">
          <div>
            <p>
              {{
                $t(
                  "Outdoor protection against sun and rain with UV resistance. Made from ASA plastic."
                )
              }}
            </p>
            <ul>
              <li>{{ $t("Recommended installation height: 3 m or above.") }}</li>
              <li>
                {{
                  $t(
                    "Wall mount (adhesive sticker): max height 3 m, operating temperature −10 °C to +35 °C."
                  )
                }}
              </li>
            </ul>
            <p>
              <b>{{ $t("In the box") }}:</b>
              {{ $t("1 Cover, 1 Wall mount, 2 Screws, 2 Double-sided tapes, 1 User manual") }}
            </p>
            <a href="/altruist-uv-cover.pdf" target="_blank" class="button">
              <font-awesome-icon icon="fa-solid fa-download" />
              {{ $t("Download UV Cover instruction") }}
            </a>
          </div>
          <img :src="coverDiagram" :alt="$t('UV Cover installation')" class="step-image" />
        </div>
      </section>

      <!-- ==================== SPECS ==================== -->
      <section id="specs">
        <h2>{{ $t("Technical Specifications") }}</h2>

        <h3>{{ $t("Altruist Urban") }}</h3>
        <div class="pagetext-table-scroll">
          <table>
            <tbody>
              <tr>
                <td>
                  <b>{{ $t("Power") }}</b>
                </td>
                <td>5V (USB-C)</td>
              </tr>
              <tr>
                <td>
                  <b>{{ $t("Wireless") }}</b>
                </td>
                <td>Wi-Fi 2.4 GHz (802.11 b/g/n)</td>
              </tr>
              <tr>
                <td>
                  <b>{{ $t("Sensors") }}</b>
                </td>
                <td>
                  SDS011 — PM2.5 / PM10 (µg/m³)<br />
                  BME280 — {{ $t("Temperature (°C/°F), Humidity (%), Pressure (hPa)") }}<br />
                  ICS43434 — {{ $t("Noise (dB)") }}
                </td>
              </tr>
              <tr>
                <td>
                  <b>{{ $t("In the box") }}</b>
                </td>
                <td>
                  {{
                    $t(
                      "Sensor module, USB-A to USB-C cable, wall mount, double-sided tape (×2), external antenna, user manual"
                    )
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>{{ $t("Altruist Insight") }}</h3>
        <div class="pagetext-table-scroll">
          <table>
            <tbody>
              <tr>
                <td>
                  <b>{{ $t("Power") }}</b>
                </td>
                <td>5V (USB-C)</td>
              </tr>
              <tr>
                <td>
                  <b>{{ $t("Wireless") }}</b>
                </td>
                <td>Wi-Fi 2.4 GHz (802.11 b/g/n)</td>
              </tr>
              <tr>
                <td>
                  <b>{{ $t("Sensors") }}</b>
                </td>
                <td>
                  SCD41 — CO2 (ppm)<br />
                  BME680 — {{ $t("Temperature (°C/°F), Humidity (%), Pressure (hPa)") }}
                </td>
              </tr>
              <tr>
                <td>
                  <b>{{ $t("In the box") }}</b>
                </td>
                <td>
                  {{ $t("Sensor module with e-ink display, USB-A to USB-C cable, user manual") }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="pagetext-highlight">
        <p>
          {{ $t("Need help? Contact support:") }}
          <a href="https://support.cyberpunks.shop" target="_blank" rel="noopener"
            >support.cyberpunks.shop</a
          >
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

// Product hero images
import urbanHero from "@/assets/images/pages/altruist-setup/urban-hero.webp";
import insightHero from "@/assets/images/pages/altruist-setup/insight-hero.webp";

// Full setup diagrams
import urbanFullDiagram from "@/assets/images/pages/altruist-setup/altruist-setup-urban.webp";
import insightFullDiagram from "@/assets/images/pages/altruist-setup/altruist-setup-insight.webp";

// Urban step images
import urbanStep1 from "@/assets/images/pages/altruist-setup/urban-step1-power.webp";
import urbanStep2 from "@/assets/images/pages/altruist-setup/urban-step2-connect.webp";
import urbanStep3 from "@/assets/images/pages/altruist-setup/urban-step3-wifi.webp";
import urbanStep4map from "@/assets/images/pages/altruist-setup/urban-step4-map.webp";
import urbanStep4gps from "@/assets/images/pages/altruist-setup/urban-step4-gps.webp";
import urbanMounting from "@/assets/images/pages/altruist-setup/urban-mounting.webp";
import urbanHA from "@/assets/images/pages/altruist-setup/urban-home-assistant.webp";

// Insight step images
import insightStep12 from "@/assets/images/pages/altruist-setup/insight-step1-2.webp";
import insightStep3 from "@/assets/images/pages/altruist-setup/insight-step3-wifi.webp";
import insightStep4map from "@/assets/images/pages/altruist-setup/insight-step4-map.webp";
import insightStep4gps from "@/assets/images/pages/altruist-setup/insight-step4-gps.webp";
import insightEink from "@/assets/images/pages/altruist-setup/insight-eink-display.webp";
import insightHA from "@/assets/images/pages/altruist-setup/insight-home-assistant.webp";

// UV Cover
import coverDiagram from "@/assets/images/pages/altruist-setup/cover-install-diagram.webp";

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

<style scoped>
.setup-nav {
  display: flex;
  gap: calc(var(--gap) * 0.6);
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  margin-bottom: calc(var(--gap) * 1.2);
  font-weight: 900;
}

.setup-navlink {
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(0, 0, 0, 0.03);
  border-radius: 999px;
  padding: 0.55rem 0.6rem;
  text-decoration: none;
  font-size: 1.2rem;
  text-decoration: none;
  transition: background 0.15s ease, transform 0.15s ease;
}

.setup-navlink:hover {
  background: rgba(0, 0, 0, 0.06);
  transform: translateY(-1px);
}

/* Intro block: text + hero image side by side */
.setup-intro {
  display: flex;
  gap: var(--gap);
  align-items: center;
  margin-bottom: var(--gap);
}

.setup-intro > div {
  flex: 1;
}

.setup-hero {
  max-width: 300px;
  width: 100%;
  height: auto;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

/* Full diagram in collapsible */
.setup-fulldiagram {
  margin: 1.5rem 0;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 12px;
  overflow: hidden;
}

.setup-fulldiagram summary {
  padding: 0.8rem 1rem;
  font-weight: 900;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.03);
}

.setup-diagram {
  display: block;
  width: 100%;
  height: auto;
}

/* Step with image side by side */
.step-with-image {
  display: flex;
  gap: calc(var(---gap) * 2);
  flex-direction: column;
  padding: calc(var(--gap) * 1);
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--surface-border), transparent 35%);
  background: color-mix(in srgb, var(--app-bodybg), transparent 6%);
}

.step-with-image p {
  hyphens: auto;
  width: 100%;
}

.step-with-image--reverse {
  flex-direction: column-reverse;
}

.step-image {
  width: 100%;
  max-width: 100%;
  height: auto;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  margin: 0;
}

.step-image--small {
  max-width: clamp(180px, 22vw, 240px);
  margin: 0;
}

.step-with-image .step-image,
.step-with-image .step-image--small {
  display: block;
  width: 100%;
}

/* Wide step images (full width) */
.step-image-wide {
  display: block;
  width: 100%;
  max-width: 700px;
  height: auto;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
}

/* Two images in a row */
.step-images-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin: 1rem 0;
}

.step-images-row .step-image-wide {
  max-width: 100%;
}

/* Mobile responsive */
@media (max-width: 900px) {
  .step-with-image,
  .step-with-image--reverse {
    flex-direction: column;
  }

  .step-with-image > div {
    min-width: 0;
  }
}

@media (max-width: 700px) {
  .setup-intro,
  .step-with-image,
  .step-with-image--reverse {
    flex-direction: column;
  }

  .setup-hero,
  .step-image,
  .step-image--small {
    max-width: 100%;
  }

  .step-images-row {
    grid-template-columns: 1fr;
  }
}
</style>
