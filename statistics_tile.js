import {
  LitElement,
  html,
} from "https://unpkg.com/lit-element@2.0.1/lit-element.js?module";

function* createRange(start, end, increment) {
  for (let i = start; i <= end; i += increment) {
    yield i;
  }
}

const aggregate_max = 'max';
const aggregate_min = 'min';
const aggregate_first = 'first';
const aggregate_last = 'last';
const aggregate_avg = 'avg';
const aggregate_sum = 'sum';
const aggregates = [
  aggregate_avg,
  aggregate_first,
  aggregate_last,
  aggregate_min,
  aggregate_max,
  aggregate_sum,
]

class StatisticsTile extends LitElement {

  // These are the elements that when change trigger the render method to update.
  static get properties() {
    return {
      _state: {state: true},
      _stats: {state: true},
      _card: {state: true},
      _config: {state: true},
      _start: {state: true},
      _end: {state: true}
    };
  }

  // Called when card is connected to the DOM.
  connectedCallback() {
    super.connectedCallback();
    const event = new CustomEvent('context-request', {
      bubbles: true,
      composed: true,
      cancelable: true,
    });

    event.context = 'states'; // The key HA's user context provider uses.
    event.subscribe = true; // Subscribe to future updates of this context, not just get the current value.
    event.callback = this._updateStates;

    this.dispatchEvent(event);
  }

  // Receive the states updates and checks if the card needs a rerender.
  _updateStates = (states, unsubscribe) => {
    this._unsubscribe = unsubscribe;

    if(!this._config) {
      console.log('No config');
      return;
    }

    const entityId = this._config.entity;
    const state = states[entityId] ?? {};

    if (this._state !== state) {
      // Trigger a rerender.
      this._state = state;
    }
  }

  // TODO I don't need state at all.

  _getDateRange = () => {
    // These are local time.

    const truncateDate = (input) => {
      // Aligns the date with the start of the day.
      // use date.setHours(date.getHours, 0, 0, 0) if you want to truncate with the start of the hour.
      const date = new Date(input);
      date.setHours(/* hours */ 0, /* minutes */ 0, /* seconds */ 0, /* millis */ 0);
      return date;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0); // Deliberately not using truncateDate().

    // If there is no userCollection then set start to start of day today
    const start = this._start ?? today;
    const end = new Date(Math.min(this._end ?? today, today));

    const rangeStart = truncateDate(start);
    const rangeEnd = truncateDate(end);

    const increment = (1000 * 60 * 60 * 24); // 1 day in ms
    const diffMs = Math.abs(rangeEnd - rangeStart);
    const count = Math.max(0, Math.floor(diffMs / increment)) + 1; 

    // In theory we can support more periods than day, a nice to have for the future.
    return {
      today,
      start: rangeStart,
      end: rangeEnd,
      period: 'day',
      count,
      increment,
    }
  }

  _connectToEnergy = () => {
    if (this._energyCollection) {
      return;
    }
    
    if (!this._hass) {
      console.log('No hass');
      return;
    }

    if (this._config?.collection_key) {
      // User specified energy connection. See other energy cards as an example.
      // If a user doesn't want an energy connection, they can put "energy_undefined".
      this._energyCollection = this._hass.connection['_' + this._config.collection_key];
    } else if (this._hass.connection['_energy']) {
      // Old way of getting the energy connection.
      this._energyCollection = this._hass.connection['_energy'];
    } else {
      // v2026.4 introduced a new key name - try that.
      const panelKey = "_energy_" + this._hass.panelUrl;
      if (this._hass.connection[panelKey]) {
        this._energyCollection = this._hass.connection[panelKey];
      }
    }

    if(this._energyCollection) {
      this._unsubscribeEnergy = this._energyCollection.subscribe(({start, end}) => {
        this._start = start;
        this._end = end;
      });
    }
  }

  _fetchStatistics = async () => {
    if (!this._hass) {
      console.log('No hass');
      return;
    }

    if (!this._config) {
      console.log('No config');
      return;
    }

    const { start, end, period } = this._getDateRange();

    // This is not the best mechanism to verify if we have already queried this range
    // But I don't really care. It will work /good enough/. 
    if (this._stats?.[start.getTime()] && this._stats?.[end.getTime()]) {
      return;
    }

    const stats = await this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [this._config.entity],
      period,
      // Using 'state' type does limit us to only 'total', and 'total_increasing'
      // metrics. In theory we could attempt some kind of schenanigans for 'measurement'
      // metrics. But that is a future problem! 
      types: ['state']
    });

    this._stats = Object.assign(this._stats ?? {}, 
      Object.fromEntries(stats[this._config.entity].filter(({state}) => state).map(({start, state}) => [start, state])));

    // TODO this should not include today??
    console.log('stats', this._stats);
  }

  _renderCard = async () => {
    if (this._card) {
      return;
    }

    if (!this._config) {
      console.log('No config');
      return;
    }

    if (!this._helpers) {
      this._helpers = await window.loadCardHelpers?.();
    }

    if(!this._helpers) {
      console.log('No helpers');
      return;
    }

    const config = {
      type: 'tile',
      entity: this._config.entity,
      ...(this._config.card ?? {}),
    }
    this._card = await this._helpers.createCardElement(config);
  }

  _calculateState = () => {
    if (!this._state || !this._stats || !this._config) {
      return "Loading...";
    }

    const { start, end, today, increment, count } = this._getDateRange();
    const includeState = end >= today; 
    const state = Number(this._state.state);

    if (this._config.aggregate === aggregate_first) {
      return this._stats[start.getTime()] ?? 'Unknown';
    }

    if (this._config.aggregate === aggregate_last) {
      if (includeState) {
        return state;
      }

      return this._stats[end.getTime()];
    }

    let result = includeState ? state : 0;
    for (const date of createRange(start.getTime(), end.getTime(), increment)) {
      const value = this._stats[date];
      if (value == null) { // Deliberately a loose equality check to also catch undefined
        return 'Calculating...';
      }

      if (this._config.aggregate === aggregate_avg || this._config.aggregate == aggregate_sum) {
        result += value;
      }

      if (this._config.aggregate === aggregate_max) {
        result = Math.max(result, value);
      }

      if (this._config.aggregate === aggregate_min) {
        result = Math.min(result, value);
      }
    }

    if(this._config.aggregate === aggregate_avg) {
      result = result / count;
    }

    return result;
  }

  _formatState = (cardState) => {
    const state = this._calculateState();
    if (typeof state === 'string') {
      return state;
    }

    const uom = this._state?.attributes?.unit_of_measurement;

    const digits = this._config?.digits ?? 2;
    const formattedState = state.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });

    // TODO We should probably call the real hass formatEntityState, passing in a modified entity
    // instead of this hacky uom stuff here. 
    if (uom) {
      return `${formattedState} ${uom}`;
    }

    return formattedState;
  }

  render() {
    // These are all async, but they also retrigger a render. 
    // So its okay we aren't actually awaiting them here.
    this._connectToEnergy();
    this._fetchStatistics();
    this._renderCard();

    if (!this._card) {
      console.log('No card');
      return;
    }

    if (!this._hass) {
      console.log('No hass');
      return;
    }

    console.log('Rendering... ' + this._config?.entity);
    this._card.hass = {
      ...this._hass,
      // Its hacky, but the only way I can figure out how to hook into the tile card render loop to display what I want.
      formatEntityState: (cardState) => this._formatState(cardState),
    };

    return html`${this._card}`;
  }

  setConfig = async (config) => {
    if (!config.entity) {
      throw new Error("You need to define an entity");
    }

    if (config.collection_key && !config.collection_key.startsWith('energy_')) {
      throw new Error("Energy collection key must start with energy_");
    }

    if (!config.aggregate || !aggregates.includes(config.aggregate)) {
      throw new Error(`Aggregate must be one of [${aggregates.join(', ')}]` )
    }

    this._config = config;
  }

  set hass(hass) {
    this._hass = hass;
  }

  getCardSize = () => {
    if (this._card) {
      return this._card.getCardSize();
    }

    // Hardcoded just like Tile card.
    return 1;
  }

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
    return "";
  }
}
customElements.define("statistics-tile", StatisticsTile);
window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "statistics-tile",
  name: "Statistics Tile",
  description: "A custom card made by me!", // optional
});
