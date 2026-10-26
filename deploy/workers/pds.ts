import { pdsSite } from '../../mock-pds/site.ts'
import { worker } from '../worker.ts'

export default worker(pdsSite)
