<template>
  <MetaInfo
    :pageTitle="$t('Where to buy Altruist')"
    :pageDescription="$t('Official and partner purchase options for Altruist devices by region.')"
    pageImage="/og-default.webp"
  />
  <PageTextLayout>
    <header class="pagetext-header">
      <div class="pagetext-eyebrow">sensors.social</div>
      <h1 class="pagetext-title">{{ $t("Where to buy air monitor Altruist") }}</h1>
      <p class="pagetext-subtitle">
        {{
          $t(
            "Two-module environment monitoring kit for indoors and outdoors — for those who care about health. You track your pulse, HRV, sleep phases. To achieve the best recovery results — you need to account for sleep conditions and the environment you live in."
          )
        }}
      </p>
    </header>

    <section class="shops">
      <a
        v-for="shop in shops"
        :key="shop.id"
        class="shop ui-surface ui-surface--lift"
        :class="{ 'shop--disabled': shop.comingSoon }"
        :data-tone="shop.tone"
        :href="shop.href || undefined"
        :target="shop.href ? '_blank' : undefined"
        :rel="shop.href ? 'noopener' : undefined"
        :aria-disabled="shop.comingSoon ? 'true' : 'false'"
        @click="shop.comingSoon ? $event.preventDefault() : null"
      >
        <div class="shop__header">
          <span class="shop__pill">{{ shop.regionLabel }}</span>
          <span v-if="shop.comingSoon" class="shop__pill shop__pill--soon">
            {{ $t("Coming soon") }}
          </span>
        </div>

        <div class="shop__logo">
          <img :src="shop.logo" :alt="shop.logoAlt" loading="lazy" />
        </div>

        <div class="shop__body">
          <p class="shop__desc">{{ shop.description }}</p>
        </div>
      </a>
    </section>
  </PageTextLayout>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import MetaInfo from "../components/MetaInfo.vue";
import PageTextLayout from "../components/layouts/PageText.vue";

import pinoutLogo from "@/assets/images/logos/pinout-logo.png";
import yandexLogo from "@/assets/images/logos/yandex-logo.svg";
import cyberpunksShopLogo from "@/assets/images/logos/cyberpunks-shop-logo.svg";
import amazonLogo from "@/assets/images/logos/amazon-logo.svg";

const { t } = useI18n();

const shops = computed(() => [
  {
    id: "worldwide",
    regionLabel: t("Worldwide"),
    comingSoon: false,
    tone: "primary",
    href: "https://cyberpunks.shop/",
    logo: cyberpunksShopLogo,
    logoAlt: t("Cyberpunks Shop"),
    title: t("Cyberpunks Shop"),
    description: t("Our online-shop with various options available. Worldwide delivery."),
  },
  {
    id: "cyprus",
    regionLabel: t("CY"),
    comingSoon: false,
    tone: "primary",
    href: "https://pinout.cloud/shop/altruist",
    logo: pinoutLogo,
    logoAlt: "Pinout",
    title: "Pinout",
    description: t("Altruist Air Quality Sensors with Installation & Setup in Cyprus"),
  },
  {
    id: "ru_cis",
    regionLabel: t("EAEU"),
    comingSoon: false,
    tone: "primary",
    href: "https://market.yandex.ru/search?generalContext=t%3Dmerchant%3Bi%3D1%3Bmrch%3D216593109%3B&rs=eJwzEvjEyMvBKLDwEKsEg0bTnOfsACoUBRA%2C&merchant-filter=216593109",
    logo: yandexLogo,
    logoAlt: t("Yandex Market"),
    title: t("Yandex Market"),
    description: t("Various options of buying Altruist: Urban only, Urban & Insight, etc."),
  },
  {
    id: "europe",
    regionLabel: t("Europe"),
    comingSoon: true,
    tone: "neutral",
    href: null,
    logo: amazonLogo,
    logoAlt: "Amazon",
    title: "Amazon",
    description: t("Amazon DE with delivery all over Europe."),
  },
]);
</script>

<style scoped>
.shops {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: calc(var(--gap) * 1.2);
  margin-top: calc(var(--gap) * 1.2);
}

.shop {
  --shop-accent: var(--color-link);
  --ui-surface-border: color-mix(in srgb, var(--shop-accent), transparent 55%);
  --ui-surface-border-hover: color-mix(in srgb, var(--shop-accent), transparent 15%);
  --ui-surface-bg: color-mix(in srgb, var(--app-bodybg), transparent 6%);
  --ui-surface-bg-hover: color-mix(in srgb, var(--ui-surface-bg), transparent 0%);
  --ui-surface-shadow: 0 10px 30px rgba(0, 0, 0, 0.06);
  --ui-surface-shadow-hover: 0 18px 44px rgba(0, 0, 0, 0.12);

  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: calc(var(--gap) * 0.7);
  padding: calc(var(--gap) * 1.1);
  text-decoration: none;
  color: inherit;
  min-height: 280px;
  position: relative;
  overflow: hidden;
}

/* If supported, align internal rows across all cards */
@supports (grid-template-rows: subgrid) {
  .shops {
    /* header / logo / body rows shared across items */
    grid-template-rows: auto minmax(140px, 1fr) auto;
  }

  .shop {
    grid-template-rows: subgrid;
    grid-row: span 3;
    min-height: 0;
  }
}

.shop:hover,
.shop:focus-visible {
  text-decoration: none;
}

.shop[data-tone="neutral"] {
  --shop-accent: color-mix(in srgb, var(--app-textcolor), transparent 45%);
  --ui-surface-border: color-mix(in srgb, var(--app-textcolor), transparent 72%);
  --ui-surface-bg: color-mix(in srgb, var(--app-bodybg), transparent 2%);
  --ui-surface-shadow: 0 10px 26px rgba(0, 0, 0, 0.05);
  --ui-surface-shadow-hover: 0 18px 40px rgba(0, 0, 0, 0.11);
}

.shop::before {
  content: "";
  position: absolute;
  inset: -2px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
  background: radial-gradient(
      700px 240px at 15% 0%,
      color-mix(in srgb, var(--shop-accent), transparent 72%),
      transparent 60%
    ),
    linear-gradient(
      120deg,
      color-mix(in srgb, var(--shop-accent), transparent 75%),
      transparent 65%
    );
}

.shop:hover::before,
.shop:focus-visible::before {
  opacity: 1;
}

.shop:focus-visible {
  box-shadow: var(--ui-surface-shadow-hover),
    0 0 0 3px color-mix(in srgb, var(--shop-accent), transparent 75%);
}

.shop:hover .shop__logo img,
.shop:focus-visible .shop__logo img {
  filter: saturate(1.05) contrast(1.02);
}

.shop--disabled {
  cursor: default;
  opacity: 0.85;
}

.shop--disabled:hover,
.shop--disabled:focus-visible {
  transform: none;
  box-shadow: var(--ui-surface-shadow);
}

.shop--disabled:hover::before,
.shop--disabled:focus-visible::before {
  opacity: 0;
}

.shop__header {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  justify-items: flex-end;
  gap: calc(var(--gap) * 0.5);
}

.shop__pill {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.7rem;
  border-radius: 999px;
  font-weight: 700;
  font-size: calc(var(--font-size) * 0.82);
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--shop-accent), transparent 0%);
  color: var(--color-light);
}

.shop[data-tone="neutral"] .shop__pill {
  background-color: var(--color-dark);
}

.shop[data-tone="neutral"] .shop__pill--soon {
  background-color: var(--color-orange);
}

.shop__logo {
  display: grid;
  place-items: center;
  padding: calc(var(--gap) * 0.5);
  min-height: 140px;
}

.shop__logo img {
  max-width: min(340px, 100%);
  max-height: 90px;
  width: auto;
  height: auto;
  object-fit: contain;
  border: none;
  margin: 0;
}

.shop__body {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: calc(var(--gap) * 0.35);
  text-align: center;
  justify-items: center;
}

.shop__desc {
  margin: 0;
  max-width: 46ch;
  color: var(--color-blue);
  font-size: calc(var(--font-size) * 0.95);
  font-weight: 600;
  line-height: 1.4;
}

.shop[data-tone="neutral"] .shop__desc {
  color: var(--color-dark);
}

@media (max-width: 900px) {
  .shops {
    grid-template-columns: 1fr;
  }

  .shop {
    min-height: 0;
  }

  .shop__logo img {
    max-width: min(300px, 100%);
  }
}
</style>
