# -*- coding: utf-8 -*-
from odoo import models, fields


class ConnectRequest(models.Model):
    _name = 'connect.request'
    _description = 'User Connect Request'

    from_user_id = fields.Many2one('res.partner', required=True)
    to_user_id = fields.Many2one('res.partner', required=True)
    state = fields.Selection([('pending', 'Pending'), ('accepted', 'Accepted'), ('rejected', 'Rejected')],
                             default='pending')
