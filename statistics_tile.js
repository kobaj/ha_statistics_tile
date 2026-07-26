import { LitElement, html, css } from "https://unpkg.com/lit-element@4.2.2/lit-element.js?module";
import { Task } from "https://unpkg.com/@lit/task@1.0.3/index.js?module";
import { DateTime } from "https://unpkg.com/luxon@3.7.2?module";

const aggregate_max = "max";
const aggregate_min = "min";
const aggregate_first = "first";
const aggregate_last = "last";
const aggregate_avg = "avg";
const aggregate_sum = "sum";
const aggregates = [aggregate_avg, aggregate_first, aggregate_last, aggregate_min, aggregate_max, aggregate_sum];

// Note! When editing this file on home assistant you need to
// manually compress it to gzip for HA to pick up the changes
//
// gzip -f -k statistics_tile.js

const calcDateRange = (startInput, endInput) => {
  // These are local time.

  const truncateDate = (input) => {
    // Aligns the date with the start of the day.
    // use date.setHours(date.getHours, 0, 0, 0) if you want to truncate with the start of the hour.
    const date = new Date(input);
    date.setHours(/* hours */ 0, /* minutes */ 0, /* seconds */ 0, /* millis */ 0);
    return date;
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0); // Deliberately not using truncateDate().

  // If there is no userCollection then set start to start of day today
  const start = startInput ?? today;
  const end = new Date(Math.min(endInput ?? today, today));

  const rangeStart = truncateDate(start);
  const rangeEnd = truncateDate(end);

  const increment = 1000 * 60 * 60 * 24; // 1 day in ms
  const diffMs = Math.abs(rangeEnd - rangeStart);
  const count = Math.max(0, Math.ceil(diffMs / increment)) + 1; // using ceil means we include today

  // Home assistant is wild in that it returns the dates from recorder statistics
  // relative to your current timezone, aligned to DST of that moment. So
  // January 1 2020 is -8 UTC, Jul 20 2020 is -7 UTC.
  //
  // What this means is you can't just add a static 86400 seconds from start to end.
  // You need to add "one day" (which may be 25 hours as you cross over DST).
  //
  // I can't do that math, so just use the luxon library. :D
  function* range() {
    const dateTimeRangEnd = DateTime.fromJSDate(rangeEnd);
    for (let i = DateTime.fromJSDate(rangeStart); i <= dateTimeRangEnd; i = i.plus({ days: 1 })) {
      yield i.toJSDate();
    }
  }

  // In theory we can support more periods than day, a nice to have for the future.
  return {
    today,
    start: rangeStart,
    end: rangeEnd,
    period: "day",
    count,
    range,
  };
};

class StatisticsTile extends LitElement {
  // These are the elements that when change trigger a Render or Task update.
  static get properties() {
    return {
      // Do not put HASS here, it updates too frequently.
      _config: { state: true, attribute: false },
      _start: { state: true, attribute: false },
      _end: { state: true, attribute: false },
      _currentState: { state: true, attribute: false },
    };
  }

  // Called when card is connected to the DOM.
  connectedCallback() {
    super.connectedCallback();
    const event = new CustomEvent("context-request", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });

    event.context = "states"; // The key HA's user context provider uses.
    event.subscribe = true; // Subscribe to future updates of this context, not just get the current value.
    event.callback = this._updateStates;

    this.dispatchEvent(event);
  }

  // Receive the states updates.
  _updateStates = (states, unsubscribe) => {
    this._unsubscribe = unsubscribe;

    if (!this._config) {
      console.log("No config");
      return;
    }

    const entityId = this._config.entity;
    const state = states[entityId];

    if (this._currentState?.state !== state?.state) {
      this._currentState = state;
    }
  };

  _calculateStartEnd = async (config) => {
    if (!config) {
      return;
    }

    const accumulateDate = (accDate, dateConfig) => {
      if (dateConfig.now) {
        return DateTime.now();
      }

      const rawables = ["startOf", "endOf", "minus", "plus", "set"];
      for (const rawable of rawables) {
        if (dateConfig[rawable]) {
          return accDate[rawable](dateConfig[rawable]);
        }
      }

      return accDate;
    };

    const calculateDate = (dateConfigs) => {
      return dateConfigs.reduce(accumulateDate, DateTime.now()).startOf("day").toJSDate();
    };

    if (config.start) {
      this._start = calculateDate(config.start);
    }

    if (config.end) {
      this._end = calculateDate(config.end);
    }
  };

  _connectToEnergy = async (config, hass) => {
    if (this._energyCollection) {
      return;
    }

    if (!config || !hass) {
      return;
    }

    if (config.start || config.end) {
      // Ignore connection key if start/end are set instead.
      return;
    }

    const connectionKey = () => {
      if (config.collection_key) {
        // User specified energy connection. See other energy cards as an example.
        // If a user doesn't want an energy connection, they can put "energy_undefined".
        return "_" + config.collection_key;
      }

      // v2026.4 introduced a new automatic key name - try that.
      return "_energy_" + hass.panelUrl;
    };

    this._energyCollection = hass.connection[connectionKey()];
    if (!this._energyCollection) {
      return;
    }

    this._unsubscribeEnergy = this._energyCollection.subscribe(({ start, end }) => {
      this._start = start;
      this._end = end;
    });
  };

  _fetchStatistics = async (config, hass, startInput, endInput) => {
    if (!config || !hass) {
      return;
    }

    const { start, end, period } = calcDateRange(startInput, endInput);
    const statsInput = this._statsInput;

    // This is not the best mechanism to verify if we have already queried this range
    // But I don't really care. It will work /good enough/.
    if (statsInput?.[start.getTime()] && statsInput?.[end.getTime()]) {
      return statsInput;
    }

    const stats = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [config.entity],
      period,
      // Using 'state' type does limit us to only 'total', and 'total_increasing'
      // metrics. In theory we could attempt some kind of schenanigans for 'measurement'
      // metrics. But that is a future problem!
      types: ["state"],
    });

    if (!stats[config.entity]) {
      // Sometimes we just don't get results :D!
      return this._statsInput;
    }

    this._statsInput = Object.assign(
      statsInput ?? {},
      Object.fromEntries(stats[config.entity].filter(({ state }) => state).map(({ start, state }) => [start, state]))
    );
    return this._statsInput;
  };

  _loadCardHelpers = async () => {
    if (this._lch) {
      return this._lch;
    }

    const loadCardHelpers = window.loadCardHelpers;
    if (!loadCardHelpers) {
      return;
    }

    this._lch = await loadCardHelpers?.();
    return this._lch;
  };

  _renderCard = async (config, helpers) => {
    if (this._card) {
      return this._card;
    }

    if (!config || !helpers) {
      return;
    }

    const cardConfig = {
      type: "tile",
      entity: config.entity,
      ...(config.card ?? {}),
    };
    this._card = await helpers.createCardElement(cardConfig);
    return this._card;
  };

  _calculateState = (config, statsInput, currentState, startInput, endInput) => {
    if (!config || !statsInput || !currentState) {
      return "Loading...";
    }

    const aggregate = config.aggregate ?? aggregate_sum;
    const { start, end, today, range, count } = calcDateRange(startInput, endInput);

    // Kind of hacky to do this, but its a cheap easy way to get the most accurate
    // value for "now" since statistics are otherwise delayed by an hour.
    const stats = Object.assign({}, statsInput, {
      [today.getTime()]: Number(currentState.state),
    });

    if (aggregate === aggregate_first) {
      return stats[start.getTime()] ?? "Unknown";
    }

    if (aggregate === aggregate_last) {
      return stats[end.getTime()] ?? "Unknown";
    }

    let result = 0;
    for (const date of range()) {
      const value = stats[date.getTime()];
      if (value == null) {
        // Deliberately a loose equality check to also catch undefined
        continue;
      }

      if (aggregate === aggregate_avg || aggregate == aggregate_sum) {
        result += value;
      }

      if (aggregate === aggregate_max) {
        result = Math.max(result, value);
      }

      if (aggregate === aggregate_min) {
        result = Math.min(result, value);
      }
    }

    if (aggregate === aggregate_avg) {
      result = result / count;
    }

    return result;
  };

  _updateCard = (hass, card, state) => {
    if (!hass || !card) {
      return html`<ha-card>${state}</ha-card>`;
    }

    card.hass = {
      ...hass,
      // Its hacky, but the only way I can figure out how to hook into the tile card render loop to display what I want.
      formatEntityState: (cardState) => {
        if (typeof state === "string") {
          return state;
        }

        return hass.formatEntityState({
          ...cardState,
          state,
        });
      },
    };

    return html`${card}`;
  };

  _renderTask = new Task(this, {
    task: async ([config, hass, currentState, startInput, endInput]) => {
      if (!config || !hass || !currentState) {
        return "Starting...";
      }

      await this._calculateStartEnd(config);
      await this._connectToEnergy(config, hass);
      const helpers = await this._loadCardHelpers();
      const card = await this._renderCard(config, helpers);
      const stats = await this._fetchStatistics(config, hass, startInput, endInput);
      const state = await this._calculateState(config, stats, currentState, startInput, endInput);

      this._state = state;
      return this._state;
    },
    args: () => [this._config, this._hass, this._currentState, this._start, this._end],
  });

  render() {
    return this._renderTask.render({
      pending: () => this._updateCard(this._hass, this._card, this._state ?? 0),
      complete: (value) => this._updateCard(this._hass, this._card, value),
      error: (e) => this._updateCard(this._hass, this._card, `Error: ${e}`),
    });
  }

  static _assertConfig = (config) => {
    if (config.collection_key && !config.collection_key.startsWith("energy_")) {
      throw new Error("Energy collection key must start with energy_");
    }

    if (config.aggregate && !aggregates.includes(config.aggregate)) {
      throw new Error(`Aggregate must be one of [${aggregates.join(", ")}]`);
    }

    if (config.start && config.collection_key) {
      throw new Error(`Cannot set both 'start' and 'collection_key', pick only one.`);
    }

    if (config.end && config.collection_key) {
      throw new Error(`Cannot set both 'end' and 'collection_key', pick only one.`);
    }
  };

  setConfig = (config) => {
    StatisticsTile._assertConfig(config);
    this._config = config;
  };

  set hass(hass) {
    this._hass = hass;
  }

  getCardSize = () => {
    if (this._card) {
      return this._card.getCardSize();
    }

    // Hardcoded just like Tile card.
    return 1;
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }

    if (this._unsubscribeEnergy) {
      this._unsubscribeEnergy();
      this._unsubscribeEnergy = undefined;
    }
  }

  static get styles() {
    return css``;
  }
  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: {} } },
        { name: "aggregate", selector: { select: { options: aggregates } } },
        { name: "collection_key", selector: { text: {} } },
      ],
      computeLabel: (schema) => {
        switch (schema.name) {
          case "aggregate":
            return "Aggregate Function";
        }
        return undefined;
      },
      computeHelper: (schema) => {
        switch (schema.name) {
          case "aggregate":
            return "How the data should be aggregated over the time range.";
          case "collection_key":
            return "Optional key to connect a collection of energy cards to any matching date picker. Energy cards on this dashboard with no key will automatically be linked together.";
        }
        return undefined;
      },
      // Do not use assertConfig.
    };
  }
}
customElements.define("statistics-tile", StatisticsTile);
window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "statistics-tile",
  name: "Statistics Tile",
  description: "A custom card made by me!", // optional
});
