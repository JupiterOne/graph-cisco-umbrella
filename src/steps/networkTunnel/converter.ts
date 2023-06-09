import {
  createDirectRelationship,
  createIntegrationEntity,
  Entity,
  parseTimePropertyValue,
  Relationship,
  RelationshipClass,
} from '@jupiterone/integration-sdk-core';
import { NetworkTunnel } from '../../types';

import { Entities } from '../constants';

export function createNetworkTunnelKey(id: number) {
  return `${Entities.NETWORK_TUNNEL._type}:${id}`;
}

export function createNetworkTunnelEntity(tunnel: NetworkTunnel): Entity {
  return createIntegrationEntity({
    entityData: {
      source: tunnel,
      assign: {
        _key: createNetworkTunnelKey(tunnel.id),
        _type: Entities.NETWORK_TUNNEL._type,
        _class: Entities.NETWORK_TUNNEL._class,
        name: tunnel.name,
        displayName: tunnel.name,
        id: tunnel.id.toString(),
        createdOn: parseTimePropertyValue(tunnel.createdAt),
        lastModifiedOn: parseTimePropertyValue(tunnel.modifiedAt),
        networkCIDRs: tunnel.networkCIDRs,
        serviceType: tunnel.serviceType,
        deviceType: tunnel.client.deviceType,
        authenticationType: tunnel.client.authentication.type,
        uri: tunnel.uri,
        transport: tunnel.transport.protocol,
        siteOriginId: tunnel.siteOriginId,
        public: false,
        internal: true,
      },
    },
  });
}

export function createSiteTunnelRelationship(
  site: Entity,
  tunnel: Entity,
): Relationship {
  return createDirectRelationship({
    _class: RelationshipClass.HAS,
    from: site,
    to: tunnel,
  });
}
