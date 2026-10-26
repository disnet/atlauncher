import { mockSite } from '../../mocks/site.ts'
import { worker } from '../worker.ts'

export default worker(() => mockSite('skyreader'))
