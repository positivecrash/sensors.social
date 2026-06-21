<template></template>

<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useHead } from "@vueuse/head";
import { useI18n } from "vue-i18n";

import { settings } from "@config";

const { locale: i18nLocale } = useI18n();

const props = defineProps({
  pageTitle: { type: String },
  pageDescription: { type: String },
  pageImage: { type: String },
  pageImageWidth: { type: String },
  pageImageHeight: { type: String },
});

const route = useRoute();
const fullUrl = computed(() => (settings?.SITE_URL || "") + route.fullPath);

const locale = computed(() => {
  return i18nLocale.value || localStorage.getItem("locale") || "en";
});

const ogdata = computed(() => ({
  site_name: settings?.SITE_NAME || "Sensors map",
  title: props.pageTitle || settings?.TITLE || settings?.SITE_NAME || "Sensors map",
  description: props.pageDescription || settings?.DESC || null,
  image: props.pageImage || null,
  image_width: props.pageImage ? props.pageImageWidth || "1280" : null,
  image_height: props.pageImage ? props.pageImageHeight || "765" : null,
  twitter: settings?.TWITTER || null,
}));

const getAbsoluteImageUrl = (imagePath) => {
  if (!imagePath) return null;
  if (imagePath.startsWith("http")) return imagePath;
  const baseUrl =
    settings?.SITE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  return `${baseUrl}${imagePath}`;
};

const meta = computed(() => {
  const d = ogdata.value;
  return [
    d.description && { name: "description", content: d.description },

    { property: "og:type", content: "website" },
    d.site_name && { property: "og:site_name", content: d.site_name },
    d.title && { property: "og:title", content: d.title },
    d.description && { property: "og:description", content: d.description },
    d.image && { property: "og:image", content: getAbsoluteImageUrl(d.image) },
    d.image && d.image_width && { property: "og:image:width", content: d.image_width },
    d.image && d.image_height && { property: "og:image:height", content: d.image_height },
    { property: "og:url", content: fullUrl.value },

    { name: "twitter:card", content: "summary_large_image" },
    d.title && { name: "twitter:title", content: d.title },
    d.image && { name: "twitter:image", content: getAbsoluteImageUrl(d.image) },
    d.description && { name: "twitter:description", content: d.description },
    d.twitter && { name: "twitter:site", content: d.twitter },
    d.twitter && { name: "twitter:creator", content: d.twitter },
  ].filter(Boolean);
});

useHead({
  title: () => ogdata.value.title,
  htmlAttrs: {
    lang: () => locale.value,
    amp: true,
    dir: "ltr",
  },
  meta: () => meta.value,
});
</script>
