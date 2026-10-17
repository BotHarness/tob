import journal from './meta/_journal.json';
import m0000 from './0000_org_config.sql';
import m0001 from './0001_minor_skrulls.sql';
import m0002 from './0002_naive_medusa.sql';
import m0003 from './0003_oval_ted_forrester.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003
    }
  }
