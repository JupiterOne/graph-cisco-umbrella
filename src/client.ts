import { IntegrationConfig } from './config';
import {
  IntegrationProviderAuthenticationError,
  IntegrationLogger,
  IntegrationProviderAuthorizationError,
  IntegrationProviderAPIError,
  IntegrationError,
} from '@jupiterone/integration-sdk-core';
import { GaxiosError, GaxiosOptions, GaxiosResponse, request } from 'gaxios';
import {
  Application,
  ApplicationCategory,
  Destination,
  DestinationList,
  Device,
  Domain,
  InternalNetwork,
  NetworkTunnel,
  Policy,
  Role,
  SessionTokenResponse,
  Site,
  UmbrellaMetaResponse,
  User,
  VirtualAppliance,
} from './types';

export type ResourceIteratee<T> = (each: T) => Promise<void> | void;

/**
 * An APIClient maintains authentication state and provides an interface to
 * third party data APIs.
 *
 * It is recommended that integrations wrap provider data APIs to provide a
 * place to handle error responses and implement common patterns for iterating
 * resources.
 */
export class APIClient {
  constructor(
    readonly config: IntegrationConfig,
    readonly logger: IntegrationLogger,
  ) {}

  private RATE_LIMIT_SLEEP_TIME = 5000;
  private MAX_RETRIES = 3;
  private PAGE_SIZE = 100;

  private BASE_URL = 'https://api.umbrella.com';
  private headers = {
    'Content-Type': 'application/json',
    Authorization: '',
  };

  // We request a token with an hour long expiration based on documentation, but
  // testing via Insomnia prior to writing this showed that the endpoint may not
  // actually be using the expires_in field and may just be defaulting to 3600.
  private async getToken(): Promise<string> {
    if (!this.headers.Authorization) {
      const encodedCredentials = Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret}`,
      ).toString('base64');
      const requestOpts: GaxiosOptions = {
        url: this.BASE_URL + '/auth/v2/token',
        method: 'POST',
        headers: {
          Authorization: `Basic ${encodedCredentials}`,
        },
        data: {
          token_type: 'bearer',
          expires_in: 3600,
        },
      };
      const response = await request<SessionTokenResponse>(requestOpts);
      this.headers.Authorization = `Bearer ${response.data.access_token}`;
    }
    return this.headers.Authorization;
  }

  public async verifyAuthentication(): Promise<void> {
    const requestOpts: GaxiosOptions = {
      url: this.BASE_URL + '/deployments/v2/sites?limit=1',
      method: 'GET',
      headers: this.headers,
    };

    const response = await this.requestWithRetry(requestOpts);

    if (response) return;
  }

  /**
   * Performs generic request and retries in the event of a 429 or authentication error (token refresh).
   *
   * @param requestOptions GaxiosOptions outlining the particulars of the request
   */
  public async requestWithRetry<T>(
    requestOptions: GaxiosOptions,
  ): Promise<GaxiosResponse<T> | undefined> {
    let retryCounter = 0;

    do {
      try {
        await this.getToken();
        const response = await request<T>(requestOptions);
        return response;
      } catch (err) {
        if (err.response?.status == 429) {
          const sleepTime = err.response?.headers['retry-after']
            ? err.response?.headers['retry-after'] * 1000
            : this.RATE_LIMIT_SLEEP_TIME;
          this.logger.info(
            `Encountered a rate limit.  Retrying in ${
              sleepTime / 1000
            } seconds.`,
          );

          retryCounter++;
          await new Promise((resolve) => setTimeout(resolve, sleepTime));
        } else if (
          (err.response?.status == 401 || err.response?.status == 403) &&
          retryCounter == 0
        ) {
          this.logger.info(
            `Encountered an authentication error.  Refreshing token and retrying.`,
          );
          this.headers.Authorization = '';
          retryCounter++;
        } else if (err instanceof GaxiosError) {
          throw this.createIntegrationError(
            err.response?.status as number,
            err.response?.statusText as string,
            err.response?.config?.url as string,
          );
        } else {
          throw new IntegrationError({
            message: err.message,
            code: err.name,
          });
        }
      }
    } while (retryCounter < this.MAX_RETRIES);
  }

  /**
   * Performs generic request with iterator.
   *
   * @param requestUrl string to append to base URL for the particular request
   * @param iteratee receives each source to produce entities/relationships
   */
  public async requestIterator<T>(
    requestUrl: string,
    iteratee: ResourceIteratee<T>,
  ): Promise<void> {
    let page = 1;
    let done = false;
    let receivedCount = 0;

    do {
      const requestOpts: GaxiosOptions = {
        url:
          this.BASE_URL + requestUrl + `?page=${page}&limit=${this.PAGE_SIZE}`,
        method: 'GET',
        headers: this.headers,
      };
      const response = await this.requestWithRetry<[T]>(requestOpts);
      if (response?.data && response.data.length > 0) {
        receivedCount = response.data.length;
        for (const item of response.data) {
          await iteratee(item);
        }
        page++;
      } else {
        done = true;
      }
    } while (!done && receivedCount == this.PAGE_SIZE);
  }

  /**
   * Performs generic request with iterator including additional response data
   * that some particular Cisco Umbrella API calls include with the general response.
   *
   * @param requestUrl string to append to base URL for the particular request
   * @param iteratee receives each source to produce entities/relationships
   */
  public async requestIteratorWithNestedData<T>(
    requestUrl: string,
    iteratee: ResourceIteratee<T>,
  ): Promise<void> {
    let page = 1;
    let done = false;
    let receivedCount = 0;

    do {
      const requestOpts: GaxiosOptions = {
        url:
          this.BASE_URL + requestUrl + `?page=${page}&limit=${this.PAGE_SIZE}`,
        method: 'GET',
        headers: this.headers,
      };
      const response = await this.requestWithRetry<UmbrellaMetaResponse<T>>(
        requestOpts,
      );
      if (response?.data?.data) {
        receivedCount = response.data.data.length;
        for (const item of response.data.data) {
          await iteratee(item);
        }
        page++;
      } else {
        done = true;
      }
    } while (!done && receivedCount == this.PAGE_SIZE);
  }

  /**
   * Iterates each destination for a given destination list.
   *
   * @param destinationLIstId ID of particular destination list we are querying
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateDestinations(
    destinationListId: number,
    iteratee: ResourceIteratee<Destination>,
  ): Promise<void> {
    await this.requestIteratorWithNestedData<Destination>(
      `/policies/v2/destinationlists/${destinationListId}/destinations`,
      iteratee,
    );
  }

  /**
   * Iterates each destination list in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateDestinationLists(
    iteratee: ResourceIteratee<DestinationList>,
  ): Promise<void> {
    // We can't use the typical requestIterator
    await this.requestIteratorWithNestedData<DestinationList>(
      `/policies/v2/destinationlists`,
      iteratee,
    );
  }

  /**
   * Iterates each domain in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateDomains(
    iteratee: ResourceIteratee<Domain>,
  ): Promise<void> {
    await this.requestIterator<Domain>(
      `/deployments/v2/internaldomains`,
      iteratee,
    );
  }

  /**
   * Iterates each network in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateNetworks(
    iteratee: ResourceIteratee<InternalNetwork>,
  ): Promise<void> {
    await this.requestIterator<InternalNetwork>(
      `/deployments/v2/internalnetworks`,
      iteratee,
    );
  }

  /**
   * Iterates each network tunnel in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateNetworkTunnels(
    iteratee: ResourceIteratee<NetworkTunnel>,
  ): Promise<void> {
    await this.requestIterator<NetworkTunnel>(
      `/deployments/v2/tunnels`,
      iteratee,
    );
  }

  /**
   * Iterates each policy in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iteratePolicies(
    iteratee: ResourceIteratee<Policy>,
  ): Promise<void> {
    await this.requestIterator<Policy>(`/deployments/v2/policies`, iteratee);
  }

  /**
   * Iterates each site in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateSites(iteratee: ResourceIteratee<Site>): Promise<void> {
    await this.requestIterator<Site>(`/deployments/v2/sites`, iteratee);
  }

  /**
   * Iterates each virtual appliance in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateVirtualAppliances(
    iteratee: ResourceIteratee<VirtualAppliance>,
  ): Promise<void> {
    await this.requestIterator<VirtualAppliance>(
      `/deployments/v2/virtualappliances`,
      iteratee,
    );
  }

  /**
   * Iterates each application scanned by the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateApplications(
    iteratee: ResourceIteratee<Application>,
  ): Promise<void> {
    await this.requestIterator<Application>(
      `/reports/v2/appDiscovery/applications`,
      iteratee,
    );
  }

  /**
   * Iterates each application category in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateApplicationCategories(
    iteratee: ResourceIteratee<ApplicationCategory>,
  ): Promise<void> {
    await this.requestIterator<ApplicationCategory>(
      `/reports/v2/appDiscovery/applicationCategories`,
      iteratee,
    );
  }

  /**
   * Iterates each device in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateDevices(
    iteratee: ResourceIteratee<Device>,
  ): Promise<void> {
    await this.requestIterator<Device>(
      `/deployments/v2/networkdevices`,
      iteratee,
    );
  }

  /**
   * Iterates each user in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateUsers(iteratee: ResourceIteratee<User>): Promise<void> {
    await this.requestIterator<User>(`/admin/v2/users`, iteratee);
  }

  /**
   * Iterates each role in the provider.
   *
   * @param iteratee receives each source to produce entities/relationships
   */
  public async iterateRoles(iteratee: ResourceIteratee<Role>): Promise<void> {
    await this.requestIterator<Role>(`/admin/v2/roles`, iteratee);
  }

  private createIntegrationError(
    status: number,
    statusText: string,
    endpoint: string,
  ) {
    this.logger.info(
      { status, statusText, endpoint },
      'Error when fetching data.',
    );
    switch (status) {
      case 401: {
        return new IntegrationProviderAuthenticationError({
          status,
          statusText,
          endpoint,
        });
      }
      case 403:
        return new IntegrationProviderAuthorizationError({
          status,
          statusText,
          endpoint,
        });
      default:
        return new IntegrationProviderAPIError({
          status,
          statusText,
          endpoint,
        });
    }
  }
}

let client: APIClient;

export function getOrCreateAPIClient(
  config: IntegrationConfig,
  logger: IntegrationLogger,
): APIClient {
  if (!client) {
    client = new APIClient(config, logger);
  }
  return client;
}
