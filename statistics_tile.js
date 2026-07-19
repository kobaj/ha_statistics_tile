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
      _stats: {state: true},
      _card: {state: true},
      _config: {state: true},
      _start: {state: true},
      _end: {state: true}
    };
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

    const connectionKey = () => {
      if (this._config?.collection_key) {
        // User specified energy connection. See other energy cards as an example.
        // If a user doesn't want an energy connection, they can put "energy_undefined".
        return '_' + this._config.collection_key;
      } 

      // v2026.4 introduced a new automatic key name - try that.
      return "_energy_" + this._hass.panelUrl;
    }

    this._energyCollection = this._hass.connection[connectionKey()];
    if (!this._energyCollection) {
      return;
    }

    this._unsubscribeEnergy = this._energyCollection.subscribe(({start, end}) => {
      this._start = start;
      this._end = end;
    });
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

      // Technically it is possible we get stuck here if loadCardHelpers is slow
      // it will set this._helpers and then this method may never get retriggered.
      return;
    }

    const config = {
      type: 'tile',
      entity: this._config.entity,
      ...(this._config.card ?? {}),
    }
    this._card = await this._helpers.createCardElement(config);
  }

  _calculateState = (cardState) => {
    if(!this._stats) {
      return 'Loading...';
    }

    const aggregate = this.config?.aggregate ?? aggregate_sum; 
    const { start, end, today, increment, count } = this._getDateRange();

    // Kind of hacky to do this, but its a cheap easy way to get the most accurate
    // value for "now" since statistics are otherwise delayed by an hour.
    const stats = Object.assign({}, this._stats, {[today.getTime()]: Number(cardState.state)})

    if (aggregate === aggregate_first) {
      return stats[start.getTime()] ?? 'Unknown';
    }

    if (aggregate === aggregate_last) {
      return stats[end.getTime()] ?? 'Unknown';
    }

    let result = 0;
    for (const date of createRange(start.getTime(), end.getTime(), increment)) {
      const value = stats[date];
      if (value == null) { // Deliberately a loose equality check to also catch undefined
        return 'Calculating...';
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

    if(aggregate === aggregate_avg) {
      result = result / count;
    }

    return result;
  }

  _formatState = (cardState) => {
    if(!this._hass) {
      console.log('No hass');
      return;
    }

    const state = this._calculateState(cardState);
    if (typeof state === 'string') {
      return state;
    }

    return this._hass.formatEntityState({
      ...cardState,
      state,
    })
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

    if (config.aggregate && !aggregates.includes(config.aggregate)) {
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
