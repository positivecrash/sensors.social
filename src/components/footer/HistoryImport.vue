<template>
  <form :action="link">
    <section>
      <select v-model="city" class="block">
        <optgroup :label="country" v-for="(country, key) in Object.keys(cities)" :key="key">
          <template v-for="(state, key2) in Object.keys(cities[country])" :key="key2">
            <option v-for="(city, key3) in cities[country][state]" :value="city" :key="key3">
              {{ city }}
            </option>
          </template>
        </optgroup>
      </select>
    </section>

    <section>
      <select v-model="period" class="block">
        <option v-for="item in timePeriod" :value="item.value" :key="item.value">
          {{ $t(item.title) }}
        </option>
      </select>
    </section>

    <section class="flexline" v-if="period === 'chooseDates'">
      <input type="date" v-model="start" :max="maxDate" />
      –
      <input type="date" v-model="end" :max="maxDate" />
    </section>

    <section>
      <input type="submit" :value="$t('history.button')" class="block" />
    </section>
  </form>
</template>

<script>
import { settings } from "@config";
import { dayISO, addMonthsISO, dayBoundsUnix } from "@/utils/date";
import { fetchSensorCities } from "@/utils/map/sensors/requests";

export default {
  data() {
    return {
      start: dayISO(Date.now() - 24 * 60 * 60 * 1000),
      end: dayISO(),
      maxDate: dayISO(),
      cities: {},
      city: "",

      timePeriod: [
        {
          title: "history.currentDay",
          value: "24hours",
        },
        {
          title: "history.currentMonth",
          value: "currentMonth",
        },
        {
          title: "history.chooseDates",
          value: "chooseDates",
        },
      ],
      period: "24hours",
    };
  },
  computed: {
    startTimestamp: function () {
      return dayBoundsUnix(this.start).start;
    },
    endTimestamp: function () {
      return dayBoundsUnix(this.end).end;
    },
    link() {
      return `${settings.REMOTE_PROVIDER}api/sensor/csv/${this.startTimestamp}/${this.endTimestamp}/${this.city}`;
    },
  },
  watch: {
    period(newPeriod) {
      if (newPeriod === "24hours") {
        this.start = dayISO();
        this.end = dayISO();
      } else if (newPeriod === "currentMonth") {
        this.start = addMonthsISO(dayISO(), -1);
        this.end = dayISO();
      }
    },
  },
  async created() {
    try {
      this.cities = await fetchSensorCities();
      const country = Object.keys(this.cities);
      const state = Object.keys(this.cities[country[0]]);
      this.city = this.cities[country[0]][state[0]][0];
    } catch (error) {
      console.log(error.message);
    }
  },
};
</script>
