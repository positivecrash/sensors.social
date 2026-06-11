<template>
  <MetaInfo
    :pageTitle="$t('Construction Site Monitoring: Data Instead of Complaints')"
    :pageDescription="
      $t(
        'Open sensor network for dust and noise control near construction sites. Continuous monitoring with open-source Altruist sensors, public data map, and citizen engagement.'
      )
    "
    pageImage="/og-construction.webp"
  />
  <PageTextLayout>
    <div class="pagetext-prose">
      <div class="pagetext-header">
        <div class="pagetext-eyebrow">sensors.social</div>
        <h1 class="pagetext-title">
          {{ $t("Construction Site Monitoring: Data Instead of Complaints") }}
        </h1>
        <p class="pagetext-subtitle">
          {{
            $t(
              "Open sensor network for dust and noise control near construction sites. Continuous monitoring with open-source Altruist sensors, public data map, and citizen engagement."
            )
          }}
        </p>
      </div>

      <section>
        <h2>{{ $t("Problem") }}</h2>

        <p>
          <b>{{ $t("Air pollution is a health threat.") }}</b>
          {{
            $t(
              "Fine particulate matter (PM2.5) causes ~200,000 premature deaths per year in Europe (EEA, 2025)."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Construction is one of the largest local sources.") }}</b>
          {{
            $t(
              "Up to 30% of urban coarse particulate (PM10) emissions in London (London Atmospheric Emissions Inventory, 2019)."
            )
          }}
        </p>

        <p>
          <b>{{ $t("EU is tightening limits by 2030.") }}</b>
          {{
            $t(
              "Directive 2024/2881: PM10 drops from 40 to 20 µg/m³ (annual), PM2.5 from 25 to 10 µg/m³. All EU member states, including Cyprus, are required to implement the new standards."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Municipalities lack real-time data.") }}</b>
          {{
            $t(
              "Control is episodic — measurements once or twice a month. Resident complaints are subjective and contain no measurements. Construction companies are not incentivized to reduce impact."
            )
          }}
        </p>
      </section>

      <section>
        <h2>{{ $t("Global Practices: Why Cities Switched to Continuous Monitoring") }}</h2>

        <p>
          <b>{{ $t("London") }}</b> —
          {{
            $t(
              "a construction boom overwhelmed councils with resident complaints. Solution: mandatory PM10 sensors at site boundaries, real-time data publicly accessible. Result: at 190 µg/m³ dusty works stop automatically — no inspector needed."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Singapore") }}</b> —
          {{
            $t(
              "dense urban fabric, construction noise unbearable in residential blocks. Developers required to monitor noise at their own expense. Fines up to SGD 50,000. Result: developers started managing noise themselves because it is cheaper than fines."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Seoul") }}</b> —
          {{
            $t(
              "citizens demanded air quality data. The city deployed tens of thousands of IoT sensors (S-DoT) — an open platform with public access. Result: decisions based on facts, not subjective assessments."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Hong Kong") }}</b> —
          {{
            $t(
              "construction incidents + air pollution triggered public pressure. 4S system mandatory since 2023: sensors, auto-alerts, auto-reports to the regulator."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Stuttgart / sensors.community (Luftdaten)") }}</b> —
          {{
            $t(
              "citizens frustrated by PM10 exceedances built their own sensor network. Started in 2015 with a handful of DIY sensors (ESP8266 + SDS011, ~EUR 30 each). Grew to tens of thousands of sensors in 70+ countries — the largest citizen air quality network in the world. Result: citizen-generated data pressured the city into driving bans and infrastructure changes."
            )
          }}
        </p>

        <p class="pagetext-highlight">
          {{
            $t(
              "Common thread: in every case, citizen complaints were the trigger, and objective public data was the solution. The Luftdaten project proved that a bottom-up citizen network can scale faster and cheaper than any top-down B2B deployment."
            )
          }}
        </p>
      </section>

      <section>
        <h2>{{ $t("KPI for Construction Companies") }}</h2>

        <table>
          <thead>
            <tr>
              <th>{{ $t("Zone") }}</th>
              <th>{{ $t("PM10 (24h)") }}</th>
              <th>{{ $t("PM10 (1h peak)") }}</th>
              <th>{{ $t("Daytime noise") }}</th>
              <th>{{ $t("Nighttime noise") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b style="color: #27ae60">{{ $t("Green") }}</b>
              </td>
              <td>&lt; 45 µg/m³</td>
              <td>&lt; 150 µg/m³</td>
              <td>&lt; 70 dB</td>
              <td>&lt; 50 dB</td>
            </tr>
            <tr>
              <td>
                <b style="color: #f39c12">{{ $t("Yellow") }}</b>
              </td>
              <td>45–80 µg/m³</td>
              <td>150–190 µg/m³</td>
              <td>70–75 dB</td>
              <td>50–55 dB</td>
            </tr>
            <tr>
              <td>
                <b style="color: #e74c3c">{{ $t("Red") }}</b>
              </td>
              <td>&gt; 80 µg/m³</td>
              <td>&gt; 190 µg/m³</td>
              <td>&gt; 75 dB</td>
              <td>&gt; 55 dB</td>
            </tr>
          </tbody>
        </table>

        <p>
          <b>{{ $t("Green zone — bonuses:") }}</b>
          {{
            $t("expedited permits, density bonus 3–5%, reduced fees, environmental deposit refund.")
          }}
        </p>

        <p>
          <b>{{ $t("Red zone — escalation:") }}</b>
          {{ $t("warning → fine → stop-work order.") }}
        </p>
      </section>

      <section>
        <h2>{{ $t("Solution — Open Sensor Network") }}</h2>

        <p>
          <b>{{ $t("Open-source Altruist sensors:") }}</b>
        </p>
        <ul>
          <li>
            {{ $t("PM2.5, PM10 (laser SDS011, periodic calibration against reference stations)") }}
          </li>
          <li>{{ $t("Noise (MEMS microphone ICS-43434)") }}</li>
          <li>{{ $t("Temperature, humidity, pressure (BME280)") }}</li>
        </ul>

        <p>
          <b>{{ $t("Local operation without clouds.") }}</b>
          {{
            $t(
              "Data is stored on network nodes within the city — decentralized cryptographic verification. Historical data cannot be falsified retroactively."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Open software — full auditability.") }}</b>
          {{
            $t(
              "The municipality, developers, and residents can verify what is measured and how. No hidden algorithms."
            )
          }}
        </p>

        <p>
          <b>{{ $t("~EUR 250 per sensor.") }}</b>
          {{
            $t(
              "Open-source design and our custom architecture make the sensor network a public good — something corporate solutions cannot offer."
            )
          }}
        </p>
      </section>

      <section>
        <h2>{{ $t("Civic Sensor Network: How It Works") }}</h2>

        <p class="pagetext-highlight">
          {{
            $t(
              "Municipality — organizer, citizens — the network. Our model follows the proven sensors.community (Luftdaten) approach — citizen engagement instead of B2B contracts with monitoring companies."
            )
          }}
        </p>

        <ol>
          <li>{{ $t("The municipality knows where construction will take place next year.") }}</li>
          <li>
            {{
              $t(
                'Announcement on the website + resident meetings: "10–20 sensors funded for homes around these construction sites."'
              )
            }}
          </li>
          <li>
            {{
              $t(
                "Residents from buildings near the site request a free sensor — via a code on the website or in person at the municipality."
              )
            }}
          </li>
          <li>
            {{
              $t(
                "Mounting on a balcony or facade — the sensor connects to Wi-Fi and starts transmitting data."
              )
            }}
          </li>
          <li>{{ $t("Data automatically appears on the public map.") }}</li>
        </ol>

        <p>
          {{
            $t(
              "The municipality keeps a stock of sensors and distributes on request, knowing the citizen's address — this ensures coverage precisely around the construction site."
            )
          }}
        </p>

        <p>
          <b>{{ $t("Result:") }}</b>
          {{
            $t(
              "a monitoring network built by residents, at minimal municipal cost (~EUR 250 × 10–20 sensors). Data on a municipal server, open-source software."
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
